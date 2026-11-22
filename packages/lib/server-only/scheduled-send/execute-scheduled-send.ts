import { prisma } from '@documenso/prisma';
import { DocumentStatus, EnvelopeScheduledSendStatus } from '@prisma/client';

import { AppError } from '../../errors/app-error';
import { jobs } from '../../jobs/client';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../types/document-audit-logs';
import type { ApiRequestMetadata } from '../../universal/extract-request-metadata';
import { createDocumentAuditLogData } from '../../utils/document-audit-logs';
import { sendDocument } from '../document/send-document';

export const SCHEDULED_SEND_USER_AGENT = 'Solid Ten Sign scheduled send';

/**
 * Send one claimed scheduled envelope.
 *
 * `claimedAt` identifies the claim. If the sweep has since re-claimed the row
 * (it thought this worker was lost), this run stops so only one send happens.
 *
 * A send that throws is final: the reasons sendDocument refuses (disabled
 * sender, missing fields, quota) do not fix themselves, so the row is marked
 * failed and the owner is told instead of retrying forever.
 */
export const executeScheduledSend = async ({
  scheduledSendId,
  claimedAt,
}: {
  scheduledSendId: string;
  claimedAt: string;
}): Promise<'SENT' | 'FAILED' | 'SKIPPED'> => {
  const row = await prisma.envelopeScheduledSend.findUnique({
    where: { id: scheduledSendId },
    include: {
      envelope: { select: { id: true, teamId: true, status: true } },
    },
  });

  if (
    !row ||
    row.status !== EnvelopeScheduledSendStatus.SENDING ||
    row.claimedAt?.toISOString() !== new Date(claimedAt).toISOString()
  ) {
    return 'SKIPPED';
  }

  // Take the claim over with a new token, so a second run of the same job (a
  // retry or a duplicate delivery) cannot also reach sendDocument.
  const startedAt = new Date();

  const { count } = await prisma.envelopeScheduledSend.updateMany({
    where: { id: row.id, status: EnvelopeScheduledSendStatus.SENDING, claimedAt: row.claimedAt },
    data: { claimedAt: startedAt },
  });

  if (count === 0) {
    return 'SKIPPED';
  }

  if (row.envelope.status !== DocumentStatus.DRAFT) {
    await markScheduledSendSent(row.id);

    return 'SENT';
  }

  const user = await prisma.user.findUnique({
    where: { id: row.userId },
    select: { id: true, email: true, name: true },
  });

  if (!user) {
    await failScheduledSend({
      scheduledSendId: row.id,
      reason: 'The person who scheduled this send no longer exists.',
    });

    return 'FAILED';
  }

  const requestMetadata: ApiRequestMetadata = {
    requestMetadata: { userAgent: SCHEDULED_SEND_USER_AGENT },
    source: 'app',
    auth: null,
    auditUser: { id: user.id, email: user.email, name: user.name },
  };

  try {
    await sendDocument({
      id: { type: 'envelopeId', id: row.envelope.id },
      userId: user.id,
      teamId: row.envelope.teamId,
      requestMetadata,
      scheduledSendClaim: { id: row.id, claimedAt: startedAt },
    });
  } catch (err) {
    const error = AppError.parseError(err);

    if (error.code === 'SCHEDULED_SEND_CLAIM_LOST') {
      return 'SKIPPED';
    }

    await failScheduledSend({ scheduledSendId: row.id, reason: describeSendFailure(err) });

    return 'FAILED';
  }

  await markScheduledSendSent(row.id);

  return 'SENT';
};

const markScheduledSendSent = async (scheduledSendId: string) => {
  await prisma.envelopeScheduledSend.updateMany({
    where: { id: scheduledSendId, status: EnvelopeScheduledSendStatus.SENDING },
    data: { status: EnvelopeScheduledSendStatus.SENT, sentAt: new Date() },
  });
};

const describeSendFailure = (err: unknown) => {
  const message = err instanceof Error ? err.message : AppError.parseError(err).message;

  return (message || 'Unknown error').slice(0, 500);
};

/**
 * Mark a SENDING row failed, write the audit entry and email the owner. Only the
 * caller that moves the row out of SENDING does the side effects.
 */
export const failScheduledSend = async ({ scheduledSendId, reason }: { scheduledSendId: string; reason: string }) => {
  const row = await prisma.envelopeScheduledSend.findUnique({
    where: { id: scheduledSendId },
  });

  if (!row) {
    return;
  }

  const { count } = await prisma.envelopeScheduledSend.updateMany({
    where: { id: row.id, status: EnvelopeScheduledSendStatus.SENDING },
    data: { status: EnvelopeScheduledSendStatus.FAILED, lastError: reason },
  });

  if (count === 0) {
    return;
  }

  await prisma.documentAuditLog.create({
    data: createDocumentAuditLogData({
      type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_SCHEDULED_SEND_FAILED,
      envelopeId: row.envelopeId,
      requestMetadata: { userAgent: SCHEDULED_SEND_USER_AGENT },
      data: {
        scheduledAt: row.scheduledAt.toISOString(),
        reason,
      },
    }),
  });

  await jobs.triggerJob({
    name: 'send.solidten.notice.email',
    payload: {
      kind: 'SCHEDULED_SEND_FAILED',
      envelopeId: row.envelopeId,
      reason,
    },
  });
};
