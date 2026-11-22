import { prisma } from '@documenso/prisma';
import { EnvelopeType } from '@prisma/client';

import { getEnvelopeWhereInput } from '../envelope/get-envelope-by-id';

/**
 * Scheduled-send rows for the given envelopes, limited to envelopes the user can see.
 */
export const findScheduledSends = async ({
  envelopeIds,
  userId,
  teamId,
}: {
  envelopeIds: string[];
  userId: number;
  teamId: number;
}) => {
  if (envelopeIds.length === 0) {
    return [];
  }

  // Reuse the per-envelope visibility rules for the whole batch.
  const { envelopeWhereInput } = await getEnvelopeWhereInput({
    id: { type: 'envelopeId', id: envelopeIds[0] },
    type: EnvelopeType.DOCUMENT,
    userId,
    teamId,
  });

  return await prisma.envelopeScheduledSend.findMany({
    where: {
      envelope: {
        id: { in: envelopeIds },
        type: EnvelopeType.DOCUMENT,
        OR: envelopeWhereInput.OR,
      },
    },
    select: {
      envelopeId: true,
      scheduledAt: true,
      timezone: true,
      status: true,
      lastError: true,
    },
  });
};
