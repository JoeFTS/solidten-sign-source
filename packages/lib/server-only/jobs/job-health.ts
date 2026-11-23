import { prisma } from '@documenso/prisma';

import { countStuckUnsealed } from './stuck-unsealed';

export type TJobHealth = {
  /** Jobs marked FAILED in the last 24 hours (each used every attempt it had). */
  failedLast24h: number;
  /** Age of the oldest PENDING job that is ready to run, in seconds; null when none. */
  oldestPendingAgeSeconds: number | null;
  /** PENDING jobs waiting for a later retry (email backoff). */
  waitingForRetry: number;
  /** Solid Ten Sign (S-2): documents whose seal failed and that nothing retries any more. */
  stuckUnsealed: number;
};

/**
 * Solid Ten: job counts for monitoring (GET /api/health). Counts only, no payloads or ids.
 * A ready PENDING job older than a few minutes means jobs are not being run.
 */
export const getJobHealth = async (now = new Date()): Promise<TJobHealth> => {
  const [failedLast24h, oldestPending, waitingForRetry, stuckUnsealed] = await Promise.all([
    prisma.backgroundJob.count({
      where: {
        status: 'FAILED',
        completedAt: { gt: new Date(now.getTime() - 24 * 60 * 60_000) },
      },
    }),
    prisma.backgroundJob.findFirst({
      where: {
        status: 'PENDING',
        OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }],
      },
      orderBy: { submittedAt: 'asc' },
      select: { submittedAt: true, nextRunAt: true },
    }),
    prisma.backgroundJob.count({
      where: { status: 'PENDING', nextRunAt: { gt: now } },
    }),
    countStuckUnsealed(now),
  ]);

  const readySince = oldestPending ? (oldestPending.nextRunAt ?? oldestPending.submittedAt) : null;

  return {
    failedLast24h,
    oldestPendingAgeSeconds: readySince ? Math.max(0, Math.round((now.getTime() - readySince.getTime()) / 1000)) : null,
    waitingForRetry,
    stuckUnsealed,
  };
};
