import { createHash } from 'node:crypto';
import { prisma } from '@documenso/prisma';
import { Prisma } from '@prisma/client';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../types/document-audit-logs';
import type { RequestMetadata } from '../../universal/extract-request-metadata';
import { createDocumentAuditLogData } from '../../utils/document-audit-logs';
import { env } from '../../utils/env';
import {
  buildSubmissionSlotWhere,
  checkPublicFormOpenedToken,
  getUnverifiedFormBlocker,
  isHoneypotFilled,
  isPublicFormVerifiedProofValid,
} from '../../utils/public-form';
import { verifyCaptchaToken } from '../captcha/verify-captcha';
import { consumeDailyQuota, getNextDailyQuotaReset, readQuotaEnv, releaseDailyQuota } from '../rate-limit/daily-quota';
import { getRetryAfterHeaders, TOO_MANY_REQUESTS_MESSAGE } from '../rate-limit/rate-limit-middleware';
import type { DirectTemplateHooks } from './direct-template-hooks';
import { assertPublicFormOpen, findPublicFormByToken, getPublicFormKey } from './find-public-form';
import { publicFormSubmitRateLimit } from './public-form-rate-limits';

export type PublicFormSubmissionInput = {
  openedToken?: string;
  verifiedProof?: string;
  honeypot?: string;
  captchaToken?: string;
};

export type PreparePublicFormSubmissionOptions = {
  directTemplateToken: string;
  directRecipientEmail: string;
  hasNextSigner: boolean;
  publicForm?: PublicFormSubmissionInput;
  requestMetadata: RequestMetadata;
};

export type PreparedPublicFormSubmission = {
  hooks: DirectTemplateHooks;
  /**
   * Give the slot back when the document could not be created.
   */
  release: () => Promise<void>;
};

const refuse = (code: string, message: string) => new AppError(code, { message, statusCode: 400 });

const formFull = () => refuse('PUBLIC_FORM_FULL', 'This form has reached its maximum number of responses.');

const proofUsed = () =>
  refuse('PUBLIC_FORM_PROOF_USED', 'This email verification was already used. Verify your email address again.');

export const hashPublicFormProof = (proof: string) => createHash('sha256').update(proof).digest('hex');

const PUBLIC_FORM_OTHER_EMAILS_ACTION = 'st.public-form.other-emails';

/** Default ceiling: emails per form per day to people other than the submitter. */
export const PUBLIC_FORM_DAILY_OTHER_EMAIL_CAP_DEFAULT = 100;

const getPublicFormDailyOtherEmailCap = () =>
  readQuotaEnv(env('NEXT_PRIVATE_ST_PUBLIC_FORM_DAILY_EMAIL_CAP'), PUBLIC_FORM_DAILY_OTHER_EMAIL_CAP_DEFAULT);

/**
 * Run every public form check before a direct template submission creates a document, and
 * take one submission slot. Returns null for a direct link that is not a public form.
 *
 * The checks run in order of cost: rate limit, honeypot, time to submit, captcha, open
 * window, email proof. The slot is taken in the document's own transaction (onCreated),
 * with a conditional update, so concurrent submissions against a cap of N create at most
 * N documents and a crash never uses up a slot.
 */
export const preparePublicFormSubmission = async ({
  directTemplateToken,
  directRecipientEmail,
  hasNextSigner,
  publicForm,
  requestMetadata,
}: PreparePublicFormSubmissionOptions): Promise<PreparedPublicFormSubmission | null> => {
  const found = await findPublicFormByToken(directTemplateToken);

  if (!found?.form) {
    return null;
  }

  const { form, directLink, envelope } = found;
  const email = directRecipientEmail.toLowerCase();
  const now = new Date();

  const rateLimit = await publicFormSubmitRateLimit.check({
    ip: requestMetadata.ipAddress ?? 'unknown',
    identifier: form.id,
  });

  if (rateLimit.isLimited) {
    throw new AppError(AppErrorCode.TOO_MANY_REQUESTS, {
      message: TOO_MANY_REQUESTS_MESSAGE,
      headers: getRetryAfterHeaders(rateLimit.reset),
    });
  }

  // Solid Ten Sign (S-H3): a stranger must never choose who else gets an email.
  if (hasNextSigner) {
    throw refuse(
      'PUBLIC_FORM_NEXT_SIGNER_REFUSED',
      'This form cannot send the document on to another person. Leave the next signer empty.',
    );
  }

  if (isHoneypotFilled(publicForm?.honeypot)) {
    throw refuse('PUBLIC_FORM_REFUSED', 'The submission was refused.');
  }

  const openedCheck = checkPublicFormOpenedToken({
    key: getPublicFormKey(),
    formId: form.id,
    token: publicForm?.openedToken,
    now,
  });

  if (openedCheck === 'TOO_FAST') {
    throw refuse('PUBLIC_FORM_TOO_FAST', 'The form was submitted too quickly. Please wait a moment and try again.');
  }

  if (openedCheck !== 'OK') {
    throw refuse('PUBLIC_FORM_RELOAD', 'This page has expired. Reload the page and fill in the form again.');
  }

  await verifyCaptchaToken({ token: publicForm?.captchaToken, ipAddress: requestMetadata.ipAddress });

  assertPublicFormOpen(form);

  let emailVerified = false;
  let verifiedProofHash: string | null = null;

  if (form.requireVerifiedEmail) {
    emailVerified = isPublicFormVerifiedProofValid({
      key: getPublicFormKey(),
      formId: form.id,
      email,
      proof: publicForm?.verifiedProof,
      now,
    });

    if (!emailVerified) {
      throw refuse('PUBLIC_FORM_EMAIL_NOT_VERIFIED', 'Verify your email address with the code we sent you.');
    }

    // Solid Ten Sign (S-H3): one proof, one document. Checked here to fail early; the unique
    // column in onCreated settles a race.
    verifiedProofHash = hashPublicFormProof(publicForm?.verifiedProof ?? '');

    const used = await prisma.stPublicFormSubmission.findUnique({ where: { verifiedProofHash } });

    if (used) {
      throw proofUsed();
    }
  } else {
    // Checked again here because recipients can be added to the template after the setting was saved.
    const blocker = getUnverifiedFormBlocker({
      recipientIds: envelope.recipients.map((recipient) => recipient.id),
      directRecipientId: directLink.directTemplateRecipientId,
      allowDictateNextSigner: envelope.documentMeta?.allowDictateNextSigner ?? false,
    });

    if (blocker) {
      throw refuse(
        'PUBLIC_FORM_NEEDS_VERIFICATION',
        'This form sends email to other people, so it must verify your email address. Ask the sender to turn on email verification.',
      );
    }
  }

  // Solid Ten Sign (S-H3): a daily ceiling on the emails one form makes the server send to
  // people other than the submitter (the template's other recipients).
  const otherRecipientCount = emailVerified
    ? envelope.recipients.filter((recipient) => recipient.id !== directLink.directTemplateRecipientId).length
    : 0;

  const otherEmailQuota = {
    action: PUBLIC_FORM_OTHER_EMAILS_ACTION,
    key: `form:${form.id}`,
    count: otherRecipientCount,
  };

  if (!(await consumeDailyQuota({ ...otherEmailQuota, max: getPublicFormDailyOtherEmailCap() }))) {
    throw new AppError(AppErrorCode.TOO_MANY_REQUESTS, {
      message: 'This form has reached its limit for today. Please try again tomorrow.',
      headers: getRetryAfterHeaders(getNextDailyQuotaReset()),
    });
  }

  // A quick check so a full form fails before any work. The binding check is the
  // conditional update in onCreated, inside the transaction that creates the document.
  if (form.maxSubmissions !== null && form.submissionCount >= form.maxSubmissions) {
    await releaseDailyQuota(otherEmailQuota);

    throw formFull();
  }

  return {
    hooks: {
      disableRecipientEmails: !emailVerified,
      onCreated: async ({ tx, envelopeId, recipientId, recipientName }) => {
        // Solid Ten Sign: the slot is taken in the transaction that creates the document and
        // the submission row, so a crash rolls back all three and never uses up a slot. The
        // conditional update locks the form row, so a cap of N still gives at most N.
        const taken = await tx.stPublicForm.updateMany({
          where: buildSubmissionSlotWhere(form.id, form.maxSubmissions),
          data: { submissionCount: { increment: 1 } },
        });

        if (taken.count === 0) {
          throw formFull();
        }

        await tx.stPublicFormSubmission
          .create({
            data: {
              formId: form.id,
              envelopeId,
              submitterEmail: email,
              submitterName: recipientName || null,
              emailVerified,
              verifiedProofHash,
              ipAddress: requestMetadata.ipAddress ?? null,
              userAgent: requestMetadata.userAgent ?? null,
            },
          })
          .catch((error: unknown) => {
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
              throw proofUsed();
            }

            throw error;
          });

        await tx.documentAuditLog.create({
          data: createDocumentAuditLogData({
            type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_PUBLIC_FORM_SUBMITTED,
            envelopeId,
            user: { name: recipientName || null, email },
            requestMetadata,
            data: {
              formId: form.id,
              recipientId,
              submitterEmail: email,
              emailVerified,
            },
          }),
        });
      },
    },
    // The slot needs no release: it rolls back with the document.
    release: async () => {
      await releaseDailyQuota(otherEmailQuota);
    },
  };
};
