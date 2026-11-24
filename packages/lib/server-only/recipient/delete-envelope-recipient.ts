import { DOCUMENT_AUDIT_LOG_TYPE } from '@documenso/lib/types/document-audit-logs';
import type { ApiRequestMetadata } from '@documenso/lib/universal/extract-request-metadata';
import { prisma } from '@documenso/prisma';
import { EnvelopeType, RecipientRole, SendStatus } from '@prisma/client';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { jobs } from '../../jobs/client';
import { extractDerivedDocumentEmailSettings } from '../../types/document-email';
import { createDocumentAuditLogData } from '../../utils/document-audit-logs';
import { canSendMailToRecipient } from '../../utils/recipient-mail';
import { canRecipientBeModified } from '../../utils/recipients';
import { buildTeamWhereQuery } from '../../utils/teams';
import { assertEnvelopeMutable } from '../envelope/assert-envelope-mutable';
import { lockEnvelopeForRecipientChange } from '../envelope/envelope-transition-lock';
import { getEnvelopeWhereInput } from '../envelope/get-envelope-by-id';
import { assertRecipientChangeAllowed } from './assert-recipient-change-allowed';

export interface DeleteEnvelopeRecipientOptions {
  userId: number;
  teamId: number;
  recipientId: number;
  requestMetadata: ApiRequestMetadata;
}

export const deleteEnvelopeRecipient = async ({
  userId,
  teamId,
  recipientId,
  requestMetadata,
}: DeleteEnvelopeRecipientOptions) => {
  const envelope = await prisma.envelope.findFirst({
    where: {
      recipients: {
        some: {
          id: recipientId,
        },
      },
      team: buildTeamWhereQuery({ teamId, userId }),
    },
    include: {
      documentMeta: true,
      team: true,
      recipients: {
        where: {
          id: recipientId,
        },
        include: {
          fields: true,
        },
      },
    },
  });

  const user = await prisma.user.findFirst({
    where: {
      id: userId,
    },
    select: {
      id: true,
      name: true,
      email: true,
    },
  });

  if (!envelope) {
    throw new AppError(AppErrorCode.NOT_FOUND, {
      message: 'Document not found',
    });
  }

  assertEnvelopeMutable(envelope);

  if (envelope.completedAt) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Document already complete',
    });
  }

  if (!user) {
    throw new AppError(AppErrorCode.NOT_FOUND, {
      message: 'User not found',
    });
  }

  const recipientToDelete = envelope.recipients[0];

  if (!recipientToDelete || recipientToDelete.id !== recipientId) {
    throw new AppError(AppErrorCode.NOT_FOUND, {
      message: 'Recipient not found',
    });
  }

  // Solid Ten Sign (R-1): the one recipient-change check, with a message that names the person.
  assertRecipientChangeAllowed(recipientToDelete, 'remove');

  if (!canRecipientBeModified(recipientToDelete, recipientToDelete.fields)) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Recipient has already interacted with the document.',
    });
  }

  const { envelopeWhereInput } = await getEnvelopeWhereInput({
    id: {
      type: 'envelopeId',
      id: envelope.id,
    },
    type: null,
    userId,
    teamId,
  });

  const deletedRecipient = await prisma.$transaction(async (tx) => {
    await assertEnvelopeMutable(envelope, tx);

    // Solid Ten Sign (FS2-C1): lock, and refuse when the recipient signed or declined since it
    // was read (a signature racing the removal).
    await lockEnvelopeForRecipientChange(tx, envelope.id, [recipientToDelete]);

    if (envelope.type === EnvelopeType.DOCUMENT) {
      await tx.documentAuditLog.create({
        data: createDocumentAuditLogData({
          type: DOCUMENT_AUDIT_LOG_TYPE.RECIPIENT_DELETED,
          envelopeId: envelope.id,
          metadata: requestMetadata,
          data: {
            recipientEmail: recipientToDelete.email,
            recipientName: recipientToDelete.name,
            recipientId: recipientToDelete.id,
            recipientRole: recipientToDelete.role,
          },
        }),
      });
    }

    return await tx.recipient.delete({
      where: {
        id: recipientId,
        envelope: envelopeWhereInput,
      },
    });
  });

  const isRecipientRemovedEmailEnabled = extractDerivedDocumentEmailSettings(envelope.documentMeta).recipientRemoved;

  // Send email to deleted recipient.
  if (
    recipientToDelete.sendStatus === SendStatus.SENT &&
    recipientToDelete.role !== RecipientRole.CC &&
    isRecipientRemovedEmailEnabled &&
    envelope.type === EnvelopeType.DOCUMENT &&
    canSendMailToRecipient(recipientToDelete)
  ) {
    // Enqueue the "removed from document" email as a background job so a
    // transient mail outage doesn't fail the request and the send is retried.
    await jobs.triggerJob({
      name: 'send.recipient.removed.email',
      payload: {
        envelopeId: envelope.id,
        recipientEmail: recipientToDelete.email,
        recipientName: recipientToDelete.name,
        inviterName: envelope.team?.name || user.name || undefined,
      },
    });
  }

  return deletedRecipient;
};
