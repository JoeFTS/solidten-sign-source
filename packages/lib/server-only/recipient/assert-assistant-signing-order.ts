import { prisma } from '@documenso/prisma';
import { DocumentSigningOrder, RecipientRole } from '@prisma/client';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { isTspEnvelope } from '../../types/signature-level';

export const ASSISTANT_NEEDS_SEQUENTIAL_MESSAGE =
  'An assistant needs a signing order. Turn on signing order (sequential signing) first.';

/**
 * Solid Ten Sign (AUD-C12): an ASSISTANT fills fields for the signers after them, so the
 * document must be signed in order. The editor enforced this; the server now does too.
 * TSP (AES/QES) envelopes are always signed in order.
 */
export const isAssistantSigningOrderValid = ({
  signingOrder,
  signatureLevel,
  roles,
}: {
  signingOrder: DocumentSigningOrder | null | undefined;
  signatureLevel: string;
  roles: Array<RecipientRole | null | undefined>;
}) =>
  !roles.includes(RecipientRole.ASSISTANT) ||
  signingOrder === DocumentSigningOrder.SEQUENTIAL ||
  isTspEnvelope({ signatureLevel });

export const assertAssistantSigningOrderValid = (options: Parameters<typeof isAssistantSigningOrderValid>[0]) => {
  if (!isAssistantSigningOrderValid(options)) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: ASSISTANT_NEEDS_SEQUENTIAL_MESSAGE,
      userMessage: ASSISTANT_NEEDS_SEQUENTIAL_MESSAGE,
      statusCode: 400,
    });
  }
};

/** For recipient writes: the roles being written, checked against the stored signing order. */
export const assertAssistantRolesAllowedOnEnvelope = async ({
  envelopeId,
  roles,
}: {
  envelopeId: string;
  roles: Array<RecipientRole | null | undefined>;
}) => {
  if (!roles.includes(RecipientRole.ASSISTANT)) {
    return;
  }

  const envelope = await prisma.envelope.findUniqueOrThrow({
    where: { id: envelopeId },
    select: { signatureLevel: true, documentMeta: { select: { signingOrder: true } } },
  });

  assertAssistantSigningOrderValid({
    signingOrder: envelope.documentMeta?.signingOrder,
    signatureLevel: envelope.signatureLevel,
    roles,
  });
};
