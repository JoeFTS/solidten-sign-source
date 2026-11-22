import { prisma } from '@documenso/prisma';
import { DocumentStatus } from '@prisma/client';

import { hashSigningToken } from './recipient-handover';

export type TSigningLinkStatus = 'ACTIVE' | 'REASSIGNED' | 'CANCELLED' | 'UNKNOWN';

/**
 * What a signing link leads to now, so a signing page that is still open can
 * show why an action failed instead of a generic error.
 */
export const getSigningLinkStatus = async ({ token }: { token: string }): Promise<TSigningLinkStatus> => {
  const recipient = await prisma.recipient.findFirst({
    where: { token },
    select: { envelope: { select: { status: true } } },
  });

  if (recipient) {
    return recipient.envelope.status === DocumentStatus.CANCELLED ? 'CANCELLED' : 'ACTIVE';
  }

  const retired = await prisma.retiredSigningToken.findUnique({
    where: { tokenHash: hashSigningToken(token) },
    select: { tokenHash: true },
  });

  return retired ? 'REASSIGNED' : 'UNKNOWN';
};
