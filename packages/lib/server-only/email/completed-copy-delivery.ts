import { prisma } from '@documenso/prisma';

import { DOCUMENT_AUDIT_LOG_TYPE } from '../../types/document-audit-logs';
import { extractDerivedDocumentEmailSettings } from '../../types/document-email';
import { canSendMailToRecipient } from '../../utils/recipient-mail';
import { getInPersonCompletionEmailRecipientIds } from '../in-person/in-person-completion-email';
import { getDocumentDeliveryForBytes, type TDocumentDelivery } from './document-email-attachments';
import { getEmailContext } from './get-email-context';
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

/**
 * Solid Ten Sign (A-1): whether this recipient gets the signed copy by email at all. The same rule
 * as the completion email job (send-document-completed-emails.handler.ts): an address the server
 * may mail (not an unverified address a visitor typed on a shared link or public form), the
 * document's "document completed" email on (or a signer hosted in person), and email not turned
 * off for the organisation. Once the copy was sent, that settles it.
 */
export const isCompletedCopyEmailed = async ({
  envelopeId,
  recipientId,
}: {
  envelopeId: string;
  recipientId: number;
}): Promise<boolean> => {
  const envelope = await prisma.envelope.findUnique({
    where: { id: envelopeId },
    select: {
      id: true,
      teamId: true,
      documentMeta: true,
      user: { select: { disabled: true } },
      recipients: { where: { id: recipientId }, select: { id: true, email: true, unverifiedEmailAt: true } },
    },
  });

  const recipient = envelope?.recipients[0];

  if (!envelope || !recipient) {
    return false;
  }

  const sent = await prisma.documentAuditLog.count({
    where: {
      envelopeId,
      type: DOCUMENT_AUDIT_LOG_TYPE.EMAIL_SENT,
      AND: [
        { data: { path: ['emailType'], equals: 'DOCUMENT_COMPLETED' } },
        { data: { path: ['recipientId'], equals: recipient.id } },
      ],
    },
  });

  if (sent > 0) {
    return true;
  }

  if (!canSendMailToRecipient(recipient) || envelope.user.disabled) {
    return false;
  }

  const isEnabled =
    extractDerivedDocumentEmailSettings(envelope.documentMeta).documentCompleted ||
    (await getInPersonCompletionEmailRecipientIds({ envelope })).includes(recipient.id);

  if (!isEnabled) {
    return false;
  }

  const { emailsDisabled } = await getEmailContext({
    emailType: 'RECIPIENT',
    source: { type: 'team', teamId: envelope.teamId },
    meta: envelope.documentMeta,
  });

  return !emailsDisabled;
};
