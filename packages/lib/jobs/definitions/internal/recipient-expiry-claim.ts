import { prisma } from '@documenso/prisma';
import { SigningStatus } from '@prisma/client';

import { DOCUMENT_AUDIT_LOG_TYPE } from '../../../types/document-audit-logs';

/** A live expiry job writes its audit entry within seconds of its claim. */
const ABANDONED_CLAIM_MS = 60_000;

/**
 * Solid Ten: true when the recipient was claimed for expiry more than a minute ago but no
 * DOCUMENT_RECIPIENT_EXPIRED entry exists: the job that claimed it died before it recorded its
 * claim, and its re-run should carry on instead of skipping the recipient for good.
 */
export const isAbandonedExpiryClaim = async (recipientId: number) => {
  const recipient = await prisma.recipient.findUnique({
    where: { id: recipientId },
    select: { envelopeId: true, expirationNotifiedAt: true, signingStatus: true },
  });

  if (
    !recipient?.expirationNotifiedAt ||
    recipient.signingStatus === SigningStatus.SIGNED ||
    recipient.signingStatus === SigningStatus.REJECTED ||
    Date.now() - recipient.expirationNotifiedAt.getTime() < ABANDONED_CLAIM_MS
  ) {
    return false;
  }

  const audit = await prisma.documentAuditLog.findFirst({
    where: {
      envelopeId: recipient.envelopeId,
      type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_RECIPIENT_EXPIRED,
      data: { path: ['recipientId'], equals: recipientId },
    },
    select: { id: true },
  });

  return !audit;
};
