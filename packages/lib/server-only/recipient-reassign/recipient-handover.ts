import { prisma } from '@documenso/prisma';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';
import type { Prisma } from '@prisma/client';
import { ReadStatus } from '@prisma/client';

import { resolveExpiresAt } from '../../constants/envelope-expiration';
import { AppError, AppErrorCode } from '../../errors/app-error';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../types/document-audit-logs';
import type { TRecipientHandoverTrigger } from '../../types/solidten-audit-logs';
import type { ApiRequestMetadata, RequestMetadata } from '../../universal/extract-request-metadata';
import { nanoid } from '../../universal/id';
import { createDocumentAuditLogData } from '../../utils/document-audit-logs';
import { getRecipientsInActiveSigningStep } from '../../utils/recipient-groups';
import { maskPhoneNumber, normalizePhoneNumber } from '../../utils/sms/phone';
import {
  type RemoveFieldFilesInTransactionOptions,
  removeFieldFilesInTransaction,
  type StoredFieldFile,
} from '../field-file/remove-field-files-in-transaction';
import { isSmsSupportedEnvelope } from '../sms/sms-availability';
import { isSmsProviderConfigured } from '../sms/sms-config';
import { assertSmsCountryAllowed } from '../sms/sms-limits';

// The one place that hands a recipient's signing request to another person or
// another phone. Every path that does that (reassign by signer or sender, a
// sender's email or phone edit, the admin edit, "dictate next signer") calls
// buildRecipientHandoverData in its recipient update and
// applyRecipientHandoverInTransaction in the same transaction, then
// notifyRecipientReassigned after commit.

/**
 * The recipient fields that start over when a request is handed over: a new
 * link token (so the old link stops working at once), unread, a fresh deadline
 * if there was one, and no reminders sent yet.
 */
export const buildRecipientHandoverData = ({
  previousExpiresAt,
  envelopeExpirationPeriod,
}: {
  previousExpiresAt: Date | null;
  envelopeExpirationPeriod: unknown;
}) => ({
  token: nanoid(),
  readStatus: ReadStatus.NOT_OPENED,
  documentDeletedAt: null,
  expiresAt: previousExpiresAt ? resolveExpiresAt(envelopeExpirationPeriod ?? null) : null,
  expirationNotifiedAt: null,
  lastReminderSentAt: null,
  nextReminderAt: null,
  reminderCount: 0,
  // Solid Ten Sign (AUD-C4 follow-up): the new address is the sender's (or a handover's) choice.
  unverifiedEmailAt: null,
});

/**
 * Remove what the previous person put on the document: their field values and
 * signature rows. Fields that sendDocument fills automatically (the recipient's
 * email, prefilled text) are filled again for the new person.
 *
 * Returns the ids of the fields that had a value, for the audit entry.
 */
export const resetRecipientFieldsForHandover = async (
  tx: Prisma.TransactionClient,
  {
    recipientId,
    newEmail,
    internalVersion,
    removedFiles,
    fileAudit,
  }: {
    recipientId: number;
    newEmail: string;
    internalVersion: number;
    /**
     * Solid Ten: receives the stored files of the old person's attachments, which this
     * removes. The caller deletes them from storage once the transaction commits.
     */
    removedFiles?: StoredFieldFile[];
    fileAudit?: Pick<RemoveFieldFilesInTransactionOptions, 'user' | 'requestMetadata' | 'metadata'>;
  },
) => {
  const fields = await tx.field.findMany({ where: { recipientId } });

  // Loaded on use: send-document pulls in the PDF, SMS and email stack, which the
  // recipient edit paths that import this module should not load up front.
  const { extractFieldAutoInsertValues } = await import('../document/send-document');

  const clearedFieldIds = fields.filter((field) => field.inserted).map((field) => field.id);

  const fieldsToAutoInsert =
    internalVersion === 2
      ? fields.flatMap((field) => {
          const value = extractFieldAutoInsertValues(field, { email: newEmail });

          return value ? [value] : [];
        })
      : [];

  await tx.signature.deleteMany({ where: { recipientId } });

  await tx.field.updateMany({
    where: { recipientId },
    data: { inserted: false, customText: '' },
  });

  // Solid Ten: the old person's attached files go with their other values.
  if (fields.length > 0) {
    const stored = await removeFieldFilesInTransaction({
      tx,
      envelopeId: fields[0].envelopeId,
      fieldIds: fields.map((field) => field.id),
      reason: 'REASSIGNED',
      ...fileAudit,
    });

    removedFiles?.push(...stored);
  }

  for (const field of fieldsToAutoInsert) {
    await tx.field.update({
      where: { id: field.fieldId },
      data: { inserted: true, customText: field.customText },
    });
  }

  return clearedFieldIds;
};

export const hashSigningToken = (token: string) => bytesToHex(sha256(token));

export const HANDOVER_EMAIL_TAKEN_MESSAGE = 'This person is already a recipient on this document.';

/**
 * Refuse handing a recipient to an email another recipient on the envelope already
 * has. Every handover path (reassign, sender edit, admin edit, dictation) refuses it
 * with the same error.
 */
export const assertHandoverEmailAvailable = ({
  recipients,
  recipientId,
  newEmail,
}: {
  recipients: { id?: number | null; email: string }[];
  recipientId: number;
  newEmail: string;
}) => {
  const normalized = newEmail.trim().toLowerCase();

  const isTaken = recipients.some(
    (other) => other.id !== recipientId && other.email.trim().toLowerCase() === normalized,
  );

  if (isTaken) {
    throw new AppError(AppErrorCode.ALREADY_EXISTS, { message: HANDOVER_EMAIL_TAKEN_MESSAGE });
  }
};

/**
 * Dictation names the next signer while the current one completes, so the check
 * runs before anything is written. The recipient that dictation would rewrite (the
 * single recipient of the next step) may keep or change its own email; any other
 * recipient's email, the current signer's included, is refused.
 */
export const assertDictatedNextSignerEmailAvailable = async ({
  envelopeId,
  currentRecipientId,
  newEmail,
}: {
  envelopeId: string;
  currentRecipientId: number;
  newEmail: string;
}) => {
  const recipients = await prisma.recipient.findMany({
    where: { envelopeId },
    select: { id: true, email: true, role: true, signingOrder: true, signingStatus: true },
  });

  const nextStep = getRecipientsInActiveSigningStep(
    recipients.filter((recipient) => recipient.id !== currentRecipientId),
  );

  if (nextStep.length !== 1) {
    return;
  }

  assertHandoverEmailAvailable({ recipients, recipientId: nextStep[0].id, newEmail });
};

export type THandoverPhone = {
  e164: string;
  optedOutAt: Date | null;
};

/**
 * Validate an optional new mobile number for a handover. Empty means "no number":
 * the new person is then reached by email.
 */
export const resolveHandoverPhone = async ({
  phoneNumber,
  envelope,
}: {
  phoneNumber: string | null | undefined;
  envelope: { internalVersion: number; signatureLevel: string };
}): Promise<THandoverPhone | null> => {
  if (!phoneNumber || phoneNumber.trim() === '') {
    return null;
  }

  if (!isSmsProviderConfigured()) {
    throw new AppError(AppErrorCode.NOT_SETUP, { message: 'Text messages are not set up on this server.' });
  }

  if (!isSmsSupportedEnvelope(envelope)) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Text messages are only available for new envelopes with simple electronic signatures.',
    });
  }

  const normalized = normalizePhoneNumber(phoneNumber);

  if (!normalized.success) {
    throw new AppError(AppErrorCode.INVALID_BODY, {
      message: 'Enter a mobile number with country code, for example +1 555 123 4567.',
    });
  }

  // Solid Ten Sign (S-M4): a number change or a reassignment must stay in the allowed countries.
  assertSmsCountryAllowed(normalized.e164);

  const optOut = await prisma.smsOptOut.findUnique({ where: { phoneE164: normalized.e164 } });

  return { e164: normalized.e164, optedOutAt: optOut?.createdAt ?? null };
};

export type ApplyRecipientHandoverOptions = {
  envelopeId: string;
  internalVersion: number;
  /** The recipient as it was before the handover, including the link token that now stops working. */
  recipient: { id: number; role: string; name: string; email: string; token: string };
  toName: string;
  toEmail: string;
  /**
   * The new person's mobile number, or null to leave the recipient without one.
   * The previous number is always removed: it must never be texted again for this recipient.
   */
  newPhone: THandoverPhone | null;
  reason?: string | null;
  reassignedBy: 'SIGNER' | 'SENDER' | 'ADMIN';
  trigger: TRecipientHandoverTrigger;
  auditUser?: { id?: number | null; email?: string | null; name?: string | null } | null;
  requestMetadata?: RequestMetadata;
  metadata?: ApiRequestMetadata;
  /** Receives the stored files of the old person's attachments; delete them after commit. */
  removedFiles?: StoredFieldFile[];
};

/**
 * The in-transaction part of every handover, after the caller has written the new
 * name, email and buildRecipientHandoverData to the recipient row: clears the old
 * person's fields, signatures and attachments, replaces the phone channel, and
 * writes the RECIPIENT_REASSIGNED audit entry.
 */
export const applyRecipientHandoverInTransaction = async (
  tx: Prisma.TransactionClient,
  options: ApplyRecipientHandoverOptions,
) => {
  const { envelopeId, internalVersion, recipient, toName, toEmail, newPhone, auditUser, requestMetadata, metadata } =
    options;

  const fileAudit: Pick<RemoveFieldFilesInTransactionOptions, 'user' | 'requestMetadata' | 'metadata'> = {
    user: auditUser ?? undefined,
    requestMetadata,
    metadata,
  };

  const clearedFieldIds = await resetRecipientFieldsForHandover(tx, {
    recipientId: recipient.id,
    newEmail: toEmail,
    internalVersion,
    removedFiles: options.removedFiles,
    fileAudit,
  });

  // Remember the dead link, by hash only, so it can say what happened.
  await tx.retiredSigningToken.createMany({
    data: [
      {
        tokenHash: hashSigningToken(recipient.token),
        envelopeId,
        recipientId: recipient.id,
        reason: 'HANDOVER',
      },
    ],
    skipDuplicates: true,
  });

  const previousChannel = await tx.recipientSmsChannel.findUnique({ where: { recipientId: recipient.id } });

  await tx.recipientSmsChannel.deleteMany({ where: { recipientId: recipient.id } });

  if (newPhone) {
    await tx.recipientSmsChannel.create({
      data: {
        recipientId: recipient.id,
        phoneE164: newPhone.e164,
        status: newPhone.optedOutAt ? 'OPTED_OUT' : 'NOT_SENT',
        optedOutAt: newPhone.optedOutAt,
      },
    });
  }

  await tx.documentAuditLog.create({
    data: createDocumentAuditLogData({
      type: DOCUMENT_AUDIT_LOG_TYPE.RECIPIENT_REASSIGNED,
      envelopeId,
      user: auditUser,
      requestMetadata,
      metadata,
      data: {
        recipientId: recipient.id,
        recipientRole: recipient.role,
        fromName: recipient.name,
        fromEmail: recipient.email,
        toName,
        toEmail,
        reason: options.reason?.trim() || null,
        reassignedBy: options.reassignedBy,
        clearedFieldIds,
        trigger: options.trigger,
        fromPhone: previousChannel ? maskPhoneNumber(previousChannel.phoneE164) : null,
        toPhone: newPhone ? maskPhoneNumber(newPhone.e164) : null,
      },
    }),
  });

  return { clearedFieldIds };
};
