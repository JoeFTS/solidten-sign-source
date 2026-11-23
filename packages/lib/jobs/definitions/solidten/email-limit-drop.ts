import { prisma } from '@documenso/prisma';
import { DocumentStatus } from '@prisma/client';

import { DOCUMENT_AUDIT_LOG_TYPE } from '../../../types/document-audit-logs';
import { createDocumentAuditLogData } from '../../../utils/document-audit-logs';

export type TLimitDroppedEmailType = 'REMINDER' | 'DOCUMENT_COMPLETED' | 'DOCUMENT_CANCELLED' | 'RECIPIENT_REMOVED';

/**
 * Solid Ten Sign (N-6): an email the organisation's email limit stopped is not silent. Every such
 * email gets one EMAIL_NOT_DELIVERED audit entry with reason LIMIT (as K-2 does for signing
 * requests). A signed copy (DOCUMENT_COMPLETED, a CC recipient's copy) also gets the existing mark
 * (deliveryFailedAt), so the document page shows "Copy not delivered" with "Resend signed copy".
 * No notice email is sent: the limit that stopped this email would stop the notice too.
 *
 * Never throws: a failure here must not change what the mail job does.
 */
export const recordEmailStoppedByLimit = async ({
  envelopeId,
  recipient,
  emailType,
}: {
  envelopeId: string;
  recipient: { id?: number; email: string; name: string; role: string };
  emailType: TLimitDroppedEmailType;
}) => {
  try {
    if (emailType === 'DOCUMENT_COMPLETED') {
      await prisma.recipient.updateMany({
        // A copy is only marked on a recipient that still exists on a completed document.
        where: { id: recipient.id ?? -1, envelope: { status: DocumentStatus.COMPLETED } },
        data: { deliveryFailedAt: new Date() },
      });
    }

    await prisma.documentAuditLog.create({
      data: createDocumentAuditLogData({
        type: DOCUMENT_AUDIT_LOG_TYPE.EMAIL_NOT_DELIVERED,
        envelopeId,
        data: {
          ...(recipient.id !== undefined ? { recipientId: recipient.id } : {}),
          recipientEmail: recipient.email,
          recipientName: recipient.name,
          recipientRole: recipient.role,
          emailType,
          attempts: 1,
          reason: 'LIMIT',
        },
      }),
    });
  } catch (err) {
    console.error('[email-limit] could not record a dropped email', { envelopeId, emailType, err });
  }
};
