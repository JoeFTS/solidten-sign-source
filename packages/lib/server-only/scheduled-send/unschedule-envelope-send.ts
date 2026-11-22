import { prisma } from '@documenso/prisma';
import { EnvelopeScheduledSendStatus, type Prisma } from '@prisma/client';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../types/document-audit-logs';
import type { ApiRequestMetadata } from '../../universal/extract-request-metadata';
import { createDocumentAuditLogData } from '../../utils/document-audit-logs';
import { getSchedulableEnvelope } from './schedule-envelope-send';

export type UnscheduleEnvelopeSendOptions = {
  envelopeId: string;
  userId: number;
  teamId: number;
  requestMetadata: ApiRequestMetadata;
};

export const unscheduleEnvelopeSend = async ({
  envelopeId,
  userId,
  teamId,
  requestMetadata,
}: UnscheduleEnvelopeSendOptions) => {
  const envelope = await getSchedulableEnvelope({ envelopeId, userId, teamId });

  const removed = await removeScheduledSend({
    envelopeId: envelope.id,
    reason: 'UNSCHEDULED',
    requestMetadata,
  });

  if (!removed) {
    throw new AppError(AppErrorCode.NOT_FOUND, {
      message: 'This document has no scheduled send to remove.',
    });
  }
};

/**
 * Atomically remove a scheduled send that the sweep has not claimed.
 *
 * Returns false when there was nothing to remove. Throws when the sweep holds
 * the row, because the send is already running and cannot be stopped.
 */
export const removeScheduledSend = async ({
  envelopeId,
  reason,
  requestMetadata,
  tx = prisma,
}: {
  envelopeId: string;
  reason: 'UNSCHEDULED' | 'SENT_MANUALLY';
  requestMetadata?: ApiRequestMetadata;
  tx?: Prisma.TransactionClient;
}) => {
  const existing = await tx.envelopeScheduledSend.findUnique({
    where: { envelopeId },
  });

  if (!existing || existing.status === EnvelopeScheduledSendStatus.SENT) {
    return false;
  }

  const { count } = await tx.envelopeScheduledSend.deleteMany({
    where: {
      id: existing.id,
      status: { in: [EnvelopeScheduledSendStatus.SCHEDULED, EnvelopeScheduledSendStatus.FAILED] },
    },
  });

  if (count === 0) {
    throw new AppError('SCHEDULED_SEND_IN_PROGRESS', {
      message: 'This document is being sent by its schedule now.',
      statusCode: 409,
    });
  }

  if (existing.status === EnvelopeScheduledSendStatus.SCHEDULED) {
    await tx.documentAuditLog.create({
      data: createDocumentAuditLogData({
        type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_SEND_UNSCHEDULED,
        envelopeId,
        metadata: requestMetadata,
        data: {
          scheduledAt: existing.scheduledAt.toISOString(),
          reason,
        },
      }),
    });
  }

  return true;
};
