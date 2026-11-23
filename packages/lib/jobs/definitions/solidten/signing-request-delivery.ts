import { prisma } from '@documenso/prisma';
import { DocumentStatus, SendStatus } from '@prisma/client';
import { z } from 'zod';

import { DOCUMENT_AUDIT_LOG_TYPE } from '../../../types/document-audit-logs';
import { createDocumentAuditLogData } from '../../../utils/document-audit-logs';
import { jobs } from '../../client';

const ZSigningEmailPayloadSchema = z.object({
  recipientId: z.number(),
});

/**
 * Solid Ten: the signing-request email to a recipient failed on every attempt (about five hours
 * of retries). Record it on the recipient (deliveryFailedAt: the UI shows "Not delivered" with a
 * resend action), write an audit entry, and queue a notice to the document owner. The notice is
 * an email job with the same retries, so it arrives once mail works again.
 */
export const markSigningRequestUndelivered = async ({
  payload,
  attempts,
  reason,
}: {
  payload: unknown;
  attempts: number;
  /** Solid Ten Sign (K-2): LIMIT when the organisation's email limit stopped the email. */
  reason?: 'LIMIT';
}) => {
  const parsed = ZSigningEmailPayloadSchema.safeParse(payload);

  if (!parsed.success) {
    return;
  }

  const recipient = await prisma.recipient.findUnique({
    where: { id: parsed.data.recipientId },
    include: { envelope: { select: { id: true, status: true } } },
  });

  if (!recipient || recipient.envelope.status !== DocumentStatus.PENDING) {
    return;
  }

  // Only the first final failure records it; a recipient who got the email (by a resend, or by
  // text) is not marked.
  const { count } = await prisma.recipient.updateMany({
    where: { id: recipient.id, sendStatus: SendStatus.NOT_SENT, deliveryFailedAt: null },
    data: { deliveryFailedAt: new Date() },
  });

  if (count === 0) {
    return;
  }

  await prisma.documentAuditLog.create({
    data: createDocumentAuditLogData({
      type: DOCUMENT_AUDIT_LOG_TYPE.EMAIL_NOT_DELIVERED,
      envelopeId: recipient.envelopeId,
      data: {
        recipientId: recipient.id,
        recipientEmail: recipient.email,
        recipientName: recipient.name,
        recipientRole: recipient.role,
        emailType: 'SIGNING_REQUEST',
        attempts,
        ...(reason ? { reason } : {}),
      },
    }),
  });

  await jobs.triggerJob({
    name: 'send.solidten.notice.email',
    payload: {
      kind: 'SIGNING_REQUEST_NOT_DELIVERED',
      envelopeId: recipient.envelopeId,
      recipientId: recipient.id,
      ...(reason ? { reason } : {}),
    },
  });
};
