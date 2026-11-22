import type { Prisma } from '@prisma/client';
import { DocumentStatus, SigningStatus } from '@prisma/client';

import { isEnvelopeAwaitingSeal, lockEnvelopeRow } from '../envelope/envelope-transition-lock';

/**
 * Solid Ten Sign (AUD-C1): the dictated-next-signer write follows the same rule as every other
 * recipient change. It takes the envelope lock and checks, under the lock, that the envelope is
 * still pending and open, and that the next recipient still has the link and the NOT_SIGNED
 * status that the caller read before the lock.
 *
 * Returns false when any check fails. The caller then writes nothing and sends no signing
 * request: the next recipient signed or declined in the meantime, got a new link, or the
 * sender cancelled or deleted the document. The signer who dictated has already completed,
 * so this is not an error for them.
 */
export const lockNextRecipientForDictation = async (
  tx: Prisma.TransactionClient,
  envelopeId: string,
  nextRecipient: { id: number; token: string },
) => {
  const status = await lockEnvelopeRow(tx, envelopeId);

  if (status !== DocumentStatus.PENDING) {
    return false;
  }

  if (await isEnvelopeAwaitingSeal(tx, envelopeId)) {
    return false;
  }

  const current = await tx.recipient.findFirst({
    where: { id: nextRecipient.id, envelopeId },
    select: { token: true, signingStatus: true },
  });

  return current?.token === nextRecipient.token && current.signingStatus === SigningStatus.NOT_SIGNED;
};
