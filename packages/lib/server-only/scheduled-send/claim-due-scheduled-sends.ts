import { prisma } from '@documenso/prisma';
import { DocumentStatus, EnvelopeScheduledSendStatus } from '@prisma/client';

import { getStaleScheduledSendOutcome, SCHEDULED_SEND_STALE_CLAIM_MS } from '../../utils/scheduled-send';
import { failScheduledSend } from './execute-scheduled-send';

export type ScheduledSendClaim = {
  scheduledSendId: string;
  claimedAt: string;
};

const SWEEP_BATCH_SIZE = 100;

/**
 * Claim every due scheduled send, plus lost claims that should be retried.
 *
 * Each row is claimed with a conditional update on its current state, so two
 * sweeps (or a sweep racing an un-schedule or a manual send) can never both
 * win the same row. The caller runs one send per returned claim.
 */
export const claimDueScheduledSends = async ({
  now = new Date(),
  envelopeIds,
}: {
  /**
   * The time due-ness is judged against. Defaults to the real clock.
   */
  now?: Date;
  /**
   * Limit the sweep to these envelopes. The cron sweep passes nothing.
   */
  envelopeIds?: string[];
} = {}) => {
  const claims: ScheduledSendClaim[] = [];

  const envelopeFilter = envelopeIds ? { envelopeId: { in: envelopeIds } } : {};

  const due = await prisma.envelopeScheduledSend.findMany({
    where: {
      ...envelopeFilter,
      status: EnvelopeScheduledSendStatus.SCHEDULED,
      scheduledAt: { lte: now },
    },
    orderBy: { scheduledAt: 'asc' },
    select: { id: true },
    take: SWEEP_BATCH_SIZE,
  });

  for (const row of due) {
    const claimedAt = new Date();

    const { count } = await prisma.envelopeScheduledSend.updateMany({
      where: {
        id: row.id,
        status: EnvelopeScheduledSendStatus.SCHEDULED,
        scheduledAt: { lte: now },
      },
      data: {
        status: EnvelopeScheduledSendStatus.SENDING,
        claimedAt,
        attempts: { increment: 1 },
      },
    });

    if (count === 1) {
      claims.push({ scheduledSendId: row.id, claimedAt: claimedAt.toISOString() });
    }
  }

  claims.push(...(await recoverStaleScheduledSends({ envelopeFilter })));

  return claims;
};

const recoverStaleScheduledSends = async ({
  envelopeFilter,
}: {
  envelopeFilter: { envelopeId?: { in: string[] } };
}) => {
  const claims: ScheduledSendClaim[] = [];

  // Staleness is measured on the real clock, never the sweep's `now`, so a claim
  // made a moment ago by a concurrent sweep is never taken over.
  const staleBefore = new Date(Date.now() - SCHEDULED_SEND_STALE_CLAIM_MS);

  const stale = await prisma.envelopeScheduledSend.findMany({
    where: {
      ...envelopeFilter,
      status: EnvelopeScheduledSendStatus.SENDING,
      OR: [{ claimedAt: null }, { claimedAt: { lte: staleBefore } }],
    },
    select: {
      id: true,
      claimedAt: true,
      attempts: true,
      envelope: { select: { status: true } },
    },
    take: SWEEP_BATCH_SIZE,
  });

  for (const row of stale) {
    const outcome = getStaleScheduledSendOutcome({
      envelopeStatus: row.envelope?.status ?? null,
      attempts: row.attempts,
    });

    const isStillTheSameClaim = {
      id: row.id,
      status: EnvelopeScheduledSendStatus.SENDING,
      claimedAt: row.claimedAt,
    };

    if (outcome === 'MARK_SENT') {
      await prisma.envelopeScheduledSend.updateMany({
        where: isStillTheSameClaim,
        data: { status: EnvelopeScheduledSendStatus.SENT, sentAt: new Date() },
      });

      continue;
    }

    if (outcome === 'FAIL') {
      const { count } = await prisma.envelopeScheduledSend.updateMany({
        where: isStillTheSameClaim,
        data: { claimedAt: new Date() },
      });

      if (count === 1) {
        await failScheduledSend({
          scheduledSendId: row.id,
          reason: 'The send was interrupted too many times. Send the document again by hand.',
        });
      }

      continue;
    }

    const claimedAt = new Date();

    const { count } = await prisma.envelopeScheduledSend.updateMany({
      where: { ...isStillTheSameClaim, envelope: { status: DocumentStatus.DRAFT } },
      data: { claimedAt, attempts: { increment: 1 } },
    });

    if (count === 1) {
      claims.push({ scheduledSendId: row.id, claimedAt: claimedAt.toISOString() });
    }
  }

  return claims;
};
