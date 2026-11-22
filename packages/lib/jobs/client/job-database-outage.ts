import { prisma } from '@documenso/prisma';
import { BackgroundJobStatus } from '@prisma/client';

import { getLastDatabaseWriteFailureAt } from '../../server-only/health/database-write-health';

/**
 * Solid Ten: a job hit by a database outage waits; it does not spend its attempts (DISK-I1).
 *
 * Before: on a full disk (writes refused, small updates still work) a failing job took the normal
 * failure path and was re-run at once, each attempt counted, so it ended FAILED within seconds
 * (email jobs spent their whole five-hour backoff ladder); each failed task also spent the task's
 * own budget. With the database down altogether the endpoint could not even record the failure:
 * the row stayed PROCESSING and the sweep later counted it as a possible process crash
 * (lastCrashedAt, 1/5/15 minute spacing, attempt budget).
 *
 * Now a failure the database caused (database-error-kind.ts) puts the job back to PENDING for
 * DATABASE_OUTAGE_WAIT_MS and gives back the attempt it used, and a cut-off row is treated as an
 * outage, not a crash, when this process saw the database refuse requests after the row started
 * (attempt given back too, LD4-L2). The run after the outage is an ordinary re-run and is counted
 * like any other: retried counts runs, and an outage adds none, however long it lasts. After a
 * process restart that knowledge is gone and the crash rules apply (a restart may be a crash).
 */
export const DATABASE_OUTAGE_WAIT_MS = 60_000;

/** The endpoint's failed attempt: back to PENDING, the attempt not counted. */
export const deferJobForDatabaseOutage = async (job: { id: string; retried: number }, now = new Date()) => {
  const { count } = await prisma.backgroundJob.updateMany({
    where: { id: job.id, status: BackgroundJobStatus.PROCESSING },
    data: {
      status: BackgroundJobStatus.PENDING,
      nextRunAt: new Date(now.getTime() + DATABASE_OUTAGE_WAIT_MS),
      lastCrashedAt: null,
      // The attempt was counted when it was claimed (retries only); give it back.
      ...(job.retried > 0 ? { retried: { decrement: 1 } } : {}),
    },
  });

  if (count === 1) {
    console.warn(
      `[JOBS]: Job ${job.id} hit a database outage; the attempt is given back and it runs again in ` +
        `${DATABASE_OUTAGE_WAIT_MS / 1000} s (that run is counted as any re-run)`,
    );
  }

  return count === 1;
};

/** True when this process saw the database refuse a request at or after `since`. */
export const wasDatabaseUnavailableSince = (since: Date) => {
  const lastFailureAt = getLastDatabaseWriteFailureAt();

  return lastFailureAt !== null && lastFailureAt >= since.getTime();
};

/** A cut-off row the outage explains: back to PENDING after the wait, the attempt not counted. */
export const deferCutOffForDatabaseOutage = async (
  candidate: { id: string; jobId: string; status: BackgroundJobStatus; updatedAt: Date; retried: number },
  now: Date,
) => {
  const { count } = await prisma.backgroundJob.updateMany({
    where: { id: candidate.id, status: candidate.status, updatedAt: candidate.updatedAt },
    data: {
      status: BackgroundJobStatus.PENDING,
      nextRunAt: new Date(now.getTime() + DATABASE_OUTAGE_WAIT_MS),
      // LD4-L2: the cut-off attempt was counted when it was claimed (every run after the first
      // is; the first run has retried 0): give it back, as the endpoint does.
      ...(candidate.retried > 0 ? { retried: { decrement: 1 } } : {}),
      updatedAt: new Date(),
    },
  });

  if (count === 1) {
    console.warn(
      `[JOBS:recovery] Job ${candidate.id} (${candidate.jobId}) was cut off during a database outage; that attempt ` +
        'is given back and the job runs again (that run is counted as any re-run)',
    );
  }

  return count === 1;
};
