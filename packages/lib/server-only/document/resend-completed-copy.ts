import { prisma } from '@documenso/prisma';
import { BackgroundJobStatus, EnvelopeType } from '@prisma/client';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { jobs } from '../../jobs/client';
import { extractDerivedDocumentEmailSettings } from '../../types/document-email';
import type { ApiRequestMetadata } from '../../universal/extract-request-metadata';
import { alphaid } from '../../universal/id';
import { getEmailContext } from '../email/get-email-context';
import { lockEnvelopeRow } from '../envelope/envelope-transition-lock';
import { getEnvelopeWhereInput } from '../envelope/get-envelope-by-id';
import { getInPersonCompletionEmailRecipientIds } from '../in-person/in-person-completion-email';
import { assertOrganisationRatesAndLimits } from '../rate-limit/assert-organisation-rates-and-limits';
import { consumeDailyQuota, releaseDailyQuota } from '../rate-limit/daily-quota';
import { assertUserNotDisabled } from '../user/assert-user-not-disabled';
import { getResendCompletedCopyRefusal } from './resend-completed-copy-rules';

/**
 * Solid Ten Sign: "Resend signed copy".
 *
 * Sends one recipient of a completed document the signed-copy email again, through the same job
 * and template as the first send (send.document.completed.emails with `resend`), so the same
 * retries, attachment-or-link rule and give-up handling apply. The job clears the recipient's
 * deliveryFailedAt only after the mail server accepted the email, and writes EMAIL_SENT
 * (isResending) with the person who asked. A new give-up marks the recipient again.
 *
 * Refused: a user who may not manage the document (same check as resend / redistribute), a
 * disabled user, a document that is not COMPLETED, a recipient of another document, an address a
 * visitor typed on a direct link (not verified), an address that is not valid for sending, a
 * recipient whose copy the document's email settings turn off, a team with email turned off, the
 * organisation's email limits, a send of this document's copies still in progress, and more than
 * RESEND_COMPLETED_COPY_DAILY_MAX resends to one recipient per UTC day.
 */
export const RESEND_COMPLETED_COPY_DAILY_MAX = 3;

export const RESEND_COMPLETED_COPY_QUOTA_ACTION = 'document.resend-signed-copy';

const COMPLETED_EMAILS_JOB_ID = 'send.document.completed.emails';

/** A resend queued this recently counts as in progress, also when its job already finished. */
const RESEND_COMPLETED_COPY_SETTLE_MS = 2 * 60 * 1000;

export const RESEND_COMPLETED_COPY_IN_PROGRESS_MESSAGE = 'The signed copy is still being sent. Try again later.';

export type ResendCompletedCopyOptions = {
  envelopeId: string;
  recipientId: number;
  userId: number;
  teamId: number;
  requestMetadata: ApiRequestMetadata;
};

const refuse = (message: string, code: AppErrorCode = AppErrorCode.INVALID_REQUEST) =>
  new AppError(code, { message, userMessage: message });

export const resendCompletedCopy = async ({
  envelopeId,
  recipientId,
  userId,
  teamId,
  requestMetadata,
}: ResendCompletedCopyOptions) => {
  const user = await prisma.user.findFirstOrThrow({
    where: { id: userId },
    select: { id: true, disabled: true },
  });

  assertUserNotDisabled(user);

  const { envelopeWhereInput } = await getEnvelopeWhereInput({
    id: { type: 'envelopeId', id: envelopeId },
    type: EnvelopeType.DOCUMENT,
    userId,
    teamId,
  });

  const envelope = await prisma.envelope.findFirst({
    where: envelopeWhereInput,
    select: {
      id: true,
      status: true,
      teamId: true,
      documentMeta: true,
      recipients: true,
      user: { select: { disabled: true } },
    },
  });

  if (!envelope) {
    throw refuse('Document not found', AppErrorCode.NOT_FOUND);
  }

  const recipient = envelope.recipients.find((candidate) => candidate.id === recipientId);

  if (!recipient) {
    throw refuse('Recipient not found', AppErrorCode.NOT_FOUND);
  }

  // The same rule as the first send (send-document-completed-emails.handler.ts): the document's
  // "document completed" email setting, or a signer hosted in person.
  const isCopyEnabledForRecipient =
    extractDerivedDocumentEmailSettings(envelope.documentMeta).documentCompleted ||
    (await getInPersonCompletionEmailRecipientIds({ envelope })).includes(recipient.id);

  const refusal = getResendCompletedCopyRefusal({ status: envelope.status, recipient, isCopyEnabledForRecipient });

  if (refusal) {
    throw refuse(refusal);
  }

  const { organisationId, claims, emailsDisabled } = await getEmailContext({
    emailType: 'RECIPIENT',
    source: { type: 'team', teamId: envelope.teamId },
    meta: envelope.documentMeta,
  });

  if (emailsDisabled || envelope.user.disabled) {
    throw refuse('Email sending is turned off for this team.');
  }

  // Solid Ten Sign (G1-D1): the check, the quota and the job insert run one request at a time per
  // envelope, under the envelope row lock (the same lock signing, cancel and delete take). Of
  // several requests at the same instant (a double click, a script) exactly one queues a job and
  // takes a quota unit; the others wait for the lock, then find that job and get "still being
  // sent". The job row is written outside this transaction (jobs.triggerJob), so it is visible
  // before the lock is released.
  await prisma.$transaction(
    async (tx) => {
      await lockEnvelopeRow(tx, envelope.id);

      // The first send, or an earlier resend, of this document's copies is still running or
      // waiting for a retry, or a resend to this recipient was queued just now (it may already
      // have finished): a second one now would send the copy twice.
      const inFlight = await tx.backgroundJob.count({
        where: {
          jobId: COMPLETED_EMAILS_JOB_ID,
          payload: { path: ['envelopeId'], equals: envelope.id },
          OR: [
            { status: { in: [BackgroundJobStatus.PENDING, BackgroundJobStatus.PROCESSING] } },
            {
              payload: { path: ['resend', 'recipientId'], equals: recipient.id },
              submittedAt: { gte: new Date(Date.now() - RESEND_COMPLETED_COPY_SETTLE_MS) },
            },
          ],
        },
      });

      if (inFlight > 0) {
        throw refuse(RESEND_COMPLETED_COPY_IN_PROGRESS_MESSAGE);
      }

      // Per recipient, so the action cannot be used to flood an address. Not turned off by
      // DANGEROUS_BYPASS_RATE_LIMITS (a daily quota).
      const quota = { action: RESEND_COMPLETED_COPY_QUOTA_ACTION, key: `recipient:${recipient.id}` };

      if (!(await consumeDailyQuota({ ...quota, max: RESEND_COMPLETED_COPY_DAILY_MAX }))) {
        throw new AppError(AppErrorCode.TOO_MANY_REQUESTS, {
          message: 'The signed copy was sent to this recipient too often today. Try again tomorrow.',
          userMessage: 'The signed copy was sent to this recipient too often today. Try again tomorrow.',
          statusCode: 429,
        });
      }

      try {
        // The organisation's email limits, as for any resend.
        await assertOrganisationRatesAndLimits({
          organisationId,
          organisationClaim: claims,
          count: 1,
          type: 'email',
        });

        await jobs.triggerJob({
          id: `completed-copy-resend:${recipient.id}:${alphaid()}`,
          name: COMPLETED_EMAILS_JOB_ID,
          payload: {
            envelopeId: envelope.id,
            requestMetadata: requestMetadata.requestMetadata,
            resend: { recipientId: recipient.id, userId },
          },
        });
      } catch (error) {
        await releaseDailyQuota(quota);

        throw error;
      }
    },
    { maxWait: 15_000, timeout: 20_000 },
  );

  return { recipientId: recipient.id };
};
