import { prisma } from '@documenso/prisma';

import { DOCUMENT_AUDIT_LOG_TYPE } from '../../types/document-audit-logs';
import { getDocumentDeliveryForBytes, type TDocumentDelivery } from './document-email-attachments';
import { getStoredDocumentBytes } from './stored-document-size';

/**
 * Solid Ten Sign (RT3-L3): how this recipient's signed copy was, or will be, emailed: as an
 * attachment or as a download link. The completion email's own audit entry decides once it
 * was sent; before that, the same size rule the email uses.
 */
export const getCompletedCopyDelivery = async ({
  envelopeId,
  recipientEmail,
}: {
  envelopeId: string;
  recipientEmail: string;
}): Promise<TDocumentDelivery> => {
  const sent = await prisma.documentAuditLog.findFirst({
    where: {
      envelopeId,
      type: DOCUMENT_AUDIT_LOG_TYPE.EMAIL_SENT,
      AND: [
        { data: { path: ['emailType'], equals: 'DOCUMENT_COMPLETED' } },
        { data: { path: ['recipientEmail'], equals: recipientEmail } },
      ],
    },
    orderBy: { createdAt: 'desc' },
    select: { data: true },
  });

  const recorded = (sent?.data as { documentDelivery?: unknown } | undefined)?.documentDelivery;

  if (recorded === 'ATTACHMENT' || recorded === 'LINK') {
    return recorded;
  }

  const items = await prisma.envelopeItem.findMany({ where: { envelopeId }, select: { documentDataId: true } });

  return getDocumentDeliveryForBytes(await getStoredDocumentBytes(items.map((item) => item.documentDataId)));
};
