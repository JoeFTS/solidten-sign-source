import { prisma } from '@documenso/prisma';
import { BackgroundJobStatus } from '@prisma/client';

import type { JobDefinition } from './_internal/job';
import { deferCutOffForDatabaseOutage, wasDatabaseUnavailableSince } from './job-database-outage';
import { handleJobFinalFailure } from './job-final-failure';
import { DEFAULT_PROCESSING_TIMEOUT_MS, getProcessingTimeoutMs } from './job-retry-policy';

/**
 * Solid Ten: recovery sweep for the local job provider.
 *
 * The local provider stores each job as a BackgroundJob row and then POSTs it to its own
 * /api/jobs endpoint. Before this sweep nothing ever looked at a row again: a POST lost in a
 * crash, a restart or a full request queue left the job PENDING (or PROCESSING) for good.
 *
 * Every minute (and once at startup) the sweep re-submits:
 * - PENDING rows that nobody picked up for PENDING_STALE_MS;
 * - PROCESSING rows older than their job's timeout (job-retry-policy.ts): the run was cut off by
 *   a crash, an out-of-memory kill or a restart.
 *
 * Each re-submission is a retry and uses one attempt of the row's budget (maxRetries), counted
 * when the sweep claims the row (also when the endpoint then refuses the request). A row whose
 * budget is spent is marked FAILED with a log line, so a job that crashes the process every time
 * it runs, or that the endpoint refuses every time, is not retried forever.
 *
 * A PROCESSING row that was cut off may have taken the process down with it (LD2-B: a job ran
 * the heap out at every start). The sweep counts the attempt at once and re-runs the row after a
 * wait. Only a SUSPECT row is marked "previously fatal" (lastCrashedAt), runs alone and waits
 * longer each time (CRASH_RETRY_MINUTES), so a poison job cannot crash-loop the app (FS3-M1):
 * - a row cut off twice in a row (cutOffCount; a normal failure resets it), or
 * - a row cut off alone: no other row was in flight or cut off at the same time.
 * A row cut off once together with others (a restart, a deploy, a crash during a burst) is not
 * evidence of a poison job: it is re-run after FIRST_CUT_OFF_WAIT_MS with the others, through the
 * job slots (job-slots.ts), seals and completion emails first. Before, every cut-off row ran
 * alone, one a minute: 115 expiry jobs in flight at a kill took over two hours.
 *
 * Several app instances can run the sweep at once. Each row is claimed with a compare-and-set
 * on (id, status, updatedAt): only the instance whose update matches the row it read wins, the
 * others see 0 rows and skip it. The job endpoint then claims the row again (PENDING to
 * PROCESSING), so a late duplicate POST still runs the job once.
 */

export const RECOVERY_INTERVAL_MS = 60_000;
export const RECOVERY_JITTER_MS = 10_000;
export const RECOVERY_STARTUP_DELAY_MS = 15_000;

/** A PENDING row older than this was never picked up. */
export const PENDING_STALE_MS = 2 * 60_000;

/** Rows handled per sweep; the next sweep takes the rest. */
export const RECOVERY_BATCH_SIZE = 200;

/** Wait before re-running a SUSPECT cut-off job, after its 1st, 2nd, ... cut-off attempt. */
export const CRASH_RETRY_MINUTES = [1, 5, 15, 60, 240];

/** Wait before re-running a row cut off once together with others (not suspect). */
export const FIRST_CUT_OFF_WAIT_MS = 60_000;

/** Rows cut off within this window count as cut off by the same event (a crash, a restart). */
export const CUT_OFF_EVENT_WINDOW_MS = 5 * 60_000;

/** Jobs re-run first after a crash: the signed copy and its emails matter most to signers. */
const RECOVERY_PRIORITY = ['internal.seal-document', 'send.document.completed.emails'];

export const sortByRecoveryPriority = <T extends { jobId: string }>(rows: T[]) => {
  const rank = (row: T) => {
    const index = RECOVERY_PRIORITY.indexOf(row.jobId);

    return index === -1 ? RECOVERY_PRIORITY.length : index;
  };

  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => rank(a.row) - rank(b.row) || a.index - b.index)
    .map(({ row }) => row);
};

/** A cut-off row is suspect when cut off twice in a row, or alone. */
export const isSuspectCutOff = (cutOffCountAfter: number, isLone: boolean) => cutOffCountAfter >= 2 || isLone;

/** When a cut-off job may run again, given its attempt count after this cut-off was counted. */
export const getCrashRetryAt = (retriedAfterCrash: number, now = new Date()) => {
  const index = Math.min(Math.max(retriedAfterCrash, 1), CRASH_RETRY_MINUTES.length) - 1;

  return new Date(now.getTime() + CRASH_RETRY_MINUTES[index] * 60_000);
};

/**
 * Of the due rows, which previously fatal ones may start now: none while another previously
 * fatal job is running, else only the first.
 */
export const pickPreviouslyFatalToRun = <T extends { lastCrashedAt: Date | null }>(
  dueRows: T[],
  isPreviouslyFatalJobRunning: boolean,
) => {
  const fatal = dueRows.filter((row) => row.lastCrashedAt !== null);

  return isPreviouslyFatalJobRunning ? [] : fatal.slice(0, 1);
};

export type TRecoveryCandidate = {
  id: string;
  jobId: string;
  status: BackgroundJobStatus;
  payload: unknown;
  updatedAt: Date;
  retried: number;
  maxRetries: number;
  lastCrashedAt: Date | null;
  cutOffCount: number | null;
};

export type TRecoverySubmit = (options: {
  jobId: string;
  jobDefinitionId: string;
  data: { name: string; payload: unknown };
  isRetry: boolean;
}) => Promise<void>;

export type TRecoveryOptions = {
  definitions: Record<string, JobDefinition>;
  submit: TRecoverySubmit;
  now?: Date;
  /** Limit the sweep to these BackgroundJob ids (tests). */
  jobIds?: string[];
  batchSize?: number;
};

export type TRecoveryResult = {
  resubmitted: string[];
  failed: string[];
  /** Cut-off rows whose attempt was counted and whose re-run waits (CRASH_RETRY_MINUTES). */
  rescheduled: string[];
};

const RECOVERY_SELECT = {
  id: true,
  jobId: true,
  status: true,
  payload: true,
  updatedAt: true,
  retried: true,
  maxRetries: true,
  lastCrashedAt: true,
  cutOffCount: true,
} as const;

/**
 * Part of each batch kept for the newest due rows (FS2-L3): with a backlog of old rows (a long
 * outage), a job lost a minute ago would otherwise wait until the whole backlog had run.
 */
export const getNewestRowsReserve = (batchSize: number) => Math.max(1, Math.ceil(batchSize / 4));

export const findPendingRecoveryCandidates = async ({
  now,
  jobIds,
  batchSize,
}: {
  now: Date;
  jobIds?: string[];
  batchSize: number;
}): Promise<TRecoveryCandidate[]> => {
  const where = {
    status: BackgroundJobStatus.PENDING,
    OR: [
      // Never picked up.
      { nextRunAt: null, updatedAt: { lt: new Date(now.getTime() - PENDING_STALE_MS) } },
      // Solid Ten: waiting for its next attempt (retry backoff), and the time has come.
      { nextRunAt: { lte: now } },
    ],
    ...(jobIds ? { id: { in: jobIds } } : {}),
  };

  const reserve = batchSize > 1 ? getNewestRowsReserve(batchSize) : 0;

  const oldest = await prisma.backgroundJob.findMany({
    where,
    orderBy: { updatedAt: 'asc' },
    take: batchSize - reserve,
    select: RECOVERY_SELECT,
  });

  if (reserve === 0) {
    return oldest;
  }

  const taken = new Set(oldest.map((row) => row.id));

  const newest = await prisma.backgroundJob.findMany({
    where: { ...where, id: { ...(jobIds ? { in: jobIds } : {}), notIn: [...taken] } },
    orderBy: { updatedAt: 'desc' },
    take: reserve,
    select: RECOVERY_SELECT,
  });

  return [...oldest, ...newest];
};

/** PROCESSING rows whose run was cut off. Filtered per job timeout after the query. */
export const findProcessingRecoveryCandidates = async ({
  now,
  jobIds,
  batchSize,
}: {
  now: Date;
  jobIds?: string[];
  batchSize: number;
}): Promise<TRecoveryCandidate[]> => {
  const rows = await prisma.backgroundJob.findMany({
    where: {
      status: BackgroundJobStatus.PROCESSING,
      // No job has a shorter timeout than the default.
      updatedAt: { lt: new Date(now.getTime() - DEFAULT_PROCESSING_TIMEOUT_MS) },
      ...(jobIds ? { id: { in: jobIds } } : {}),
    },
    orderBy: { updatedAt: 'asc' },
    take: batchSize * 4,
    select: RECOVERY_SELECT,
  });

  return rows
    .filter((row) => row.updatedAt.getTime() < now.getTime() - getProcessingTimeoutMs(row.jobId))
    .slice(0, batchSize);
};

export const hasSpentAttemptBudget = (candidate: Pick<TRecoveryCandidate, 'retried' | 'maxRetries'>) =>
  candidate.retried >= candidate.maxRetries;

/**
 * Claim a row for this instance. Returns false when another instance (or the job endpoint)
 * changed the row after we read it.
 *
 * The claim counts the attempt (FS2-M1). The job endpoint used to count it when it claimed the
 * row, but it refuses some requests before that claim (400 for a payload its schema no longer
 * accepts, 401, 404): such a row was re-submitted every sweep forever and never spent its budget.
 * A previously fatal row's attempt was already counted when it was rescheduled.
 */
export const claimRecoveryCandidate = async (candidate: TRecoveryCandidate) => {
  const countsAttempt = candidate.lastCrashedAt === null;

  const { count } = await prisma.backgroundJob.updateMany({
    where: {
      id: candidate.id,
      status: candidate.status,
      updatedAt: candidate.updatedAt,
    },
    data: {
      status: BackgroundJobStatus.PENDING,
      nextRunAt: null,
      ...(countsAttempt ? { retried: { increment: 1 }, lastRetriedAt: new Date() } : {}),
      updatedAt: new Date(),
    },
  });

  return count === 1;
};

/**
 * A PROCESSING row that was cut off: count the attempt now, mark it previously fatal and let it
 * wait. The sweep starts it when nextRunAt has passed.
 */
export const rescheduleCutOffCandidate = async (candidate: TRecoveryCandidate, now: Date, isLone = true) => {
  const cutOffCount = (candidate.cutOffCount ?? 0) + 1;
  const isSuspect = isSuspectCutOff(cutOffCount, isLone);
  const nextRunAt = isSuspect
    ? getCrashRetryAt(candidate.retried + 1, now)
    : new Date(now.getTime() + FIRST_CUT_OFF_WAIT_MS);

  const { count } = await prisma.backgroundJob.updateMany({
    where: {
      id: candidate.id,
      status: candidate.status,
      updatedAt: candidate.updatedAt,
    },
    data: {
      status: BackgroundJobStatus.PENDING,
      retried: { increment: 1 },
      lastRetriedAt: now,
      lastCrashedAt: isSuspect ? now : null,
      cutOffCount,
      nextRunAt,
      updatedAt: new Date(),
    },
  });

  if (count === 1) {
    console.warn(
      isSuspect
        ? `[JOBS:recovery] Job ${candidate.id} (${candidate.jobId}) was cut off on attempt ${candidate.retried + 1} ` +
            `(${cutOffCount > 1 ? `${cutOffCount} times in a row` : 'alone'}); it may have stopped the process. ` +
            `It runs alone; next attempt at ${nextRunAt.toISOString()}`
        : `[JOBS:recovery] Job ${candidate.id} (${candidate.jobId}) was cut off with other jobs on attempt ` +
            `${candidate.retried + 1}; re-run at ${nextRunAt.toISOString()}`,
    );
  }

  return count === 1;
};

export const failRecoveryCandidate = async (candidate: TRecoveryCandidate, reason: string) => {
  const { count } = await prisma.backgroundJob.updateMany({
    where: {
      id: candidate.id,
      status: candidate.status,
      updatedAt: candidate.updatedAt,
    },
    data: {
      status: BackgroundJobStatus.FAILED,
      completedAt: new Date(),
    },
  });

  if (count === 1) {
    console.error(`[JOBS:recovery] Gave up on job ${candidate.id} (${candidate.jobId}): ${reason}`);

    await handleJobFinalFailure(candidate);
  }

  return count === 1;
};

export const runLocalJobRecovery = async (options: TRecoveryOptions): Promise<TRecoveryResult> => {
  const { definitions, submit, now = new Date(), jobIds, batchSize = RECOVERY_BATCH_SIZE } = options;

  const result: TRecoveryResult = { resubmitted: [], failed: [], rescheduled: [] };

  // Cut-off rows first: they are counted and wait, they never start in this sweep.
  const processing = await findProcessingRecoveryCandidates({ now, jobIds, batchSize });
  const pending = await findPendingRecoveryCandidates({ now, jobIds, batchSize });

  const isPreviouslyFatalJobRunning =
    (await prisma.backgroundJob.count({
      where: {
        status: BackgroundJobStatus.PROCESSING,
        lastCrashedAt: { not: null },
        id: { notIn: processing.map((row) => row.id) },
      },
    })) > 0;

  const fatalAllowed = new Set(pickPreviouslyFatalToRun(pending, isPreviouslyFatalJobRunning).map((row) => row.id));

  const candidates = [
    ...processing,
    ...sortByRecoveryPriority(pending.filter((row) => !row.lastCrashedAt || fatalAllowed.has(row.id))),
  ];

  // Solid Ten (FS3-M1): was a cut-off row the only one? Other rows in flight (PROCESSING for a
  // while) or cut off in the same event (rescheduled in the last minutes) say it was not alone.
  const cutOffSiblings =
    processing.length > 1
      ? processing.length - 1
      : await prisma.backgroundJob.count({
          where: {
            id: { notIn: processing.map((row) => row.id) },
            OR: [
              { status: BackgroundJobStatus.PROCESSING, updatedAt: { lt: new Date(now.getTime() - 2 * 60_000) } },
              { cutOffCount: { gte: 1 }, lastRetriedAt: { gte: new Date(now.getTime() - CUT_OFF_EVENT_WINDOW_MS) } },
            ],
          },
        });

  for (const candidate of candidates) {
    const definition = definitions[candidate.jobId];

    // A job that no code can run any more would be picked up every sweep.
    if (!definition || definition.enabled === false) {
      if (await failRecoveryCandidate(candidate, 'no enabled job definition')) {
        result.failed.push(candidate.id);
      }

      continue;
    }

    // Solid Ten (DISK-I1): cut off by a database outage this process saw, not by a crash.
    if (candidate.status === BackgroundJobStatus.PROCESSING && wasDatabaseUnavailableSince(candidate.updatedAt)) {
      if (await deferCutOffForDatabaseOutage(candidate, now)) {
        result.rescheduled.push(candidate.id);
      }

      continue;
    }

    if (hasSpentAttemptBudget(candidate)) {
      const reason = `attempt budget spent (${candidate.retried + 1} attempts, last one ${candidate.status === BackgroundJobStatus.PROCESSING ? 'cut off' : 'never started'})`;

      if (await failRecoveryCandidate(candidate, reason)) {
        result.failed.push(candidate.id);
      }

      continue;
    }

    if (candidate.status === BackgroundJobStatus.PROCESSING) {
      if (await rescheduleCutOffCandidate(candidate, now, cutOffSiblings === 0)) {
        result.rescheduled.push(candidate.id);
      }

      continue;
    }

    if (!(await claimRecoveryCandidate(candidate))) {
      continue;
    }

    const isPreviouslyFatal = candidate.lastCrashedAt !== null;

    console.log(
      `[JOBS:recovery] Re-submitting job ${candidate.id} (${candidate.jobId})${isPreviouslyFatal ? ', previously cut off, alone' : ''}`,
    );

    await submit({
      jobId: candidate.id,
      jobDefinitionId: candidate.jobId,
      data: { name: definition.trigger.name, payload: candidate.payload },
      // The claim above counted the attempt (or the reschedule did, for a cut-off row), so the
      // endpoint must not count it again.
      isRetry: false,
    });

    result.resubmitted.push(candidate.id);
  }

  return result;
};
