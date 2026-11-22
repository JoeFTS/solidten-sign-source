import { prisma } from '@documenso/prisma';
import { DocumentStatus, RecipientRole, SigningStatus } from '@prisma/client';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../types/document-audit-logs';
import type { ApiRequestMetadata } from '../../universal/extract-request-metadata';
import { createDocumentAuditLogData, diffRecipientChanges } from '../../utils/document-audit-logs';
import { lockEnvelopeForRecipientChange } from '../envelope/envelope-transition-lock';
import { deleteStoredFieldFiles, type StoredFieldFile } from '../field-file/remove-field-files-in-transaction';
import { notifyRecipientReassigned } from '../recipient-reassign/notify-recipient-reassigned';
import {
  applyRecipientHandoverInTransaction,
  assertHandoverEmailAvailable,
  buildRecipientHandoverData,
} from '../recipient-reassign/recipient-handover';

export type UpdateRecipientOptions = {
  id: number;
  name: string | undefined;
  email: string | undefined;
  role: RecipientRole | undefined;
  /** Solid Ten: the admin's request, for the audit entry when the email changes on a sent document. */
  metadata?: ApiRequestMetadata;
};

export const updateRecipient = async ({ id, name, email, role, metadata }: UpdateRecipientOptions) => {
  const recipient = await prisma.recipient.findFirst({
    where: {
      id,
    },
    include: {
      envelope: { include: { documentMeta: true } },
    },
  });

  // Solid Ten Sign (RT3-L2): an unknown id is a 404, not a raw database error.
  if (!recipient) {
    throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Recipient not found', statusCode: 404 });
  }

  if (recipient.signingStatus === SigningStatus.SIGNED) {
    // Solid Ten Sign (RT2-L2): a refusal, not a server error.
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Cannot update a recipient that has already signed.',
      statusCode: 400,
    });
  }

  const newEmail = email?.toLowerCase();

  // Solid Ten: on a sent document a new email is a new person, so the link moves with it
  // (the old link must not sign as the new person). Same handover as every other path.
  const isHandover =
    newEmail !== undefined &&
    newEmail !== recipient.email.toLowerCase() &&
    recipient.envelope.status === DocumentStatus.PENDING &&
    recipient.role !== RecipientRole.CC;

  if (!isHandover) {
    // Solid Ten: an admin change is never unaudited. The admin is the actor.
    return await prisma.$transaction(async (tx) => {
      const updated = await tx.recipient.update({
        where: {
          id,
        },
        data: {
          name,
          email: newEmail,
          role,
        },
      });

      const changes = diffRecipientChanges(recipient, updated);

      if (changes.length > 0) {
        await tx.documentAuditLog.create({
          data: createDocumentAuditLogData({
            type: DOCUMENT_AUDIT_LOG_TYPE.RECIPIENT_UPDATED,
            envelopeId: recipient.envelopeId,
            metadata,
            data: {
              recipientEmail: updated.email,
              recipientName: updated.name,
              recipientId: updated.id,
              recipientRole: updated.role,
              changes,
            },
          }),
        });
      }

      return updated;
    });
  }

  const otherRecipients = await prisma.recipient.findMany({
    where: { envelopeId: recipient.envelopeId },
    select: { id: true, email: true },
  });

  assertHandoverEmailAvailable({ recipients: otherRecipients, recipientId: recipient.id, newEmail });

  const removedFiles: StoredFieldFile[] = [];

  const updated = await prisma.$transaction(async (tx) => {
    // Solid Ten Sign (FS2-C1): lock, and refuse when the recipient signed, declined or got a new
    // link since it was read.
    await lockEnvelopeForRecipientChange(tx, recipient.envelopeId, [recipient]);

    const result = await tx.recipient.update({
      where: { id },
      data: {
        name,
        email: newEmail,
        role,
        ...buildRecipientHandoverData({
          previousExpiresAt: recipient.expiresAt,
          envelopeExpirationPeriod: recipient.envelope.documentMeta?.envelopeExpirationPeriod,
        }),
      },
    });

    await applyRecipientHandoverInTransaction(tx, {
      envelopeId: recipient.envelopeId,
      internalVersion: recipient.envelope.internalVersion,
      recipient,
      toName: result.name,
      toEmail: result.email,
      newPhone: null,
      reassignedBy: 'ADMIN',
      trigger: 'ADMIN_EDIT',
      metadata,
      removedFiles,
    });

    return result;
  });

  await deleteStoredFieldFiles(removedFiles);

  await notifyRecipientReassigned({
    envelopeId: recipient.envelopeId,
    recipientId: recipient.id,
    previous: { email: recipient.email, name: recipient.name, sendStatus: recipient.sendStatus },
    isSelfReassigned: false,
    requestMetadata: metadata?.requestMetadata,
  });

  return updated;
};
