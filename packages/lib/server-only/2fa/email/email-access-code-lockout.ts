/**
 * Solid Ten Sign (AUD-1): an attempt limit on the emailed access code.
 *
 * The code has six digits and about ten values are valid at any time, so it
 * must not be open to unlimited guesses. Every check first takes one attempt
 * from the recipient's budget in a single conditional UPDATE, so parallel or
 * batched guesses cannot pass the limit. A right code gives the budget back.
 * When the budget is used up, the code check is locked (an audit entry is
 * written) until a new code is requested.
 */
import { prisma } from '@documenso/prisma';

import { AppError, AppErrorCode } from '../../../errors/app-error';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../../types/document-audit-logs';
import type { RequestMetadata } from '../../../universal/extract-request-metadata';
import { createDocumentAuditLogData } from '../../../utils/document-audit-logs';
import { validateTwoFactorTokenFromEmail } from './validate-2fa-token-from-email';

export const EMAIL_ACCESS_CODE_MAX_ATTEMPTS = 5;

export const EMAIL_ACCESS_CODE_LOCKED_MESSAGE = 'Too many wrong codes. Request a new code and try again.';

type CheckEmailAccessCodeOptions = {
  recipient: { id: number; envelopeId: string; email: string; name: string };
  code: string;
  requestMetadata?: RequestMetadata;
};

/**
 * Whether the emailed access code is right. Throws TOO_MANY_REQUESTS when the
 * recipient has no attempts left.
 */
export const checkEmailAccessCodeWithLimit = async ({
  recipient,
  code,
  requestMetadata,
}: CheckEmailAccessCodeOptions): Promise<boolean> => {
  const taken = await prisma.recipient.updateMany({
    where: { id: recipient.id, accessCodeFailedAttempts: { lt: EMAIL_ACCESS_CODE_MAX_ATTEMPTS } },
    data: { accessCodeFailedAttempts: { increment: 1 } },
  });

  if (taken.count === 0) {
    throw new AppError(AppErrorCode.TOO_MANY_REQUESTS, {
      message: EMAIL_ACCESS_CODE_LOCKED_MESSAGE,
      userMessage: EMAIL_ACCESS_CODE_LOCKED_MESSAGE,
      statusCode: 429,
    });
  }

  const isValid = await validateTwoFactorTokenFromEmail({
    envelopeId: recipient.envelopeId,
    email: recipient.email,
    code,
    window: 10, // 5 minutes worth of tokens
  });

  if (isValid) {
    await prisma.recipient.update({
      where: { id: recipient.id },
      data: { accessCodeFailedAttempts: 0 },
    });

    return true;
  }

  await writeLockEntryOnce({ recipient, requestMetadata });

  return false;
};

/**
 * Writes the lock entry once per lock. A conditional update moves the counter
 * one past the limit, so only one of several parallel guesses writes it.
 */
const writeLockEntryOnce = async ({
  recipient,
  requestMetadata,
}: Pick<CheckEmailAccessCodeOptions, 'recipient' | 'requestMetadata'>) => {
  const marked = await prisma.recipient.updateMany({
    where: { id: recipient.id, accessCodeFailedAttempts: EMAIL_ACCESS_CODE_MAX_ATTEMPTS },
    data: { accessCodeFailedAttempts: EMAIL_ACCESS_CODE_MAX_ATTEMPTS + 1 },
  });

  if (marked.count === 0) {
    return;
  }

  await prisma.documentAuditLog.create({
    data: createDocumentAuditLogData({
      type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_ACCESS_AUTH_2FA_LOCKED,
      envelopeId: recipient.envelopeId,
      requestMetadata,
      data: {
        recipientId: recipient.id,
        recipientName: recipient.name,
        recipientEmail: recipient.email,
        failedAttempts: EMAIL_ACCESS_CODE_MAX_ATTEMPTS,
      },
    }),
  });
};

/** A new code was sent: the recipient gets a full set of attempts again. */
export const resetEmailAccessCodeAttempts = async (recipientId: number) => {
  await prisma.recipient.update({
    where: { id: recipientId },
    data: { accessCodeFailedAttempts: 0 },
  });
};
