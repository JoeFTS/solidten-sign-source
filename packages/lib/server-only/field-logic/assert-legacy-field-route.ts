import { prisma } from '@documenso/prisma';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { fieldUsesLogic } from '../../utils/field-conditions';

/**
 * Solid Ten Sign (S-L2): the legacy field routes (field.signFieldWithToken and
 * field.removeSignedFieldWithToken) do not run the field-rule checks. They are refused
 * for version-2 envelopes that use field rules (conditions or formulas); those are signed
 * through envelope.field.sign, which runs them. Other envelopes keep working as before.
 */
export const assertLegacyFieldRouteAllowed = async ({ token }: { token: string; fieldId: number }) => {
  // Solid Ten Sign (AUD-C3): decide on the envelope the token belongs to. A lookup among the
  // token holder's own fields missed an assistant acting on a later signer's field.
  const recipient = await prisma.recipient.findFirst({
    where: { token },
    select: { envelope: { select: { id: true, internalVersion: true } } },
  });

  // An unknown token is left to the route, which answers as before.
  if (!recipient || recipient.envelope.internalVersion !== 2) {
    return;
  }

  const fields = await prisma.field.findMany({
    where: { envelopeId: recipient.envelope.id },
    select: { fieldMeta: true },
  });

  if (fields.some((item) => fieldUsesLogic(item.fieldMeta))) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'This document uses field rules and cannot be signed through this route. Reload the signing page.',
    });
  }
};
