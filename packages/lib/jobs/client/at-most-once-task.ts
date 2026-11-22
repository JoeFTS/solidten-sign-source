import { prisma } from '@documenso/prisma';
import type { BackgroundJobTask } from '@prisma/client';
import { BackgroundJobStatus, Prisma } from '@prisma/client';

import type { JobRunIO } from './_internal/job';
import type { Json } from './_internal/json';

/**
 * Solid Ten: at-most-once tasks for the local job provider.
 *
 * A task is cached once its callback returns, so a re-run skips it. One window is left: the
 * process dies after the side effect (an email was accepted by the mail server) but before the
 * task row is marked COMPLETED. A normal task then runs again: at least once.
 *
 * An at-most-once task writes a "started" marker right before its side effect (the callback calls
 * `markSending`). A re-run that finds the marker on a task that never finished and never recorded
 * a failure knows the earlier attempt was cut off during the send, and skips it: at most once. Use it for messages where a duplicate
 * is worse than a rare missing one (reminders, notices to the owner).
 */

const STARTED_MARKER_KEY = '__solidtenStartedAt';

export const isCutOffAtMostOnceTask = (task: Pick<BackgroundJobTask, 'status' | 'result'>) =>
  task.status === BackgroundJobStatus.PENDING &&
  typeof task.result === 'object' &&
  task.result !== null &&
  !Array.isArray(task.result) &&
  STARTED_MARKER_KEY in task.result;

/** A write that must land together with the "sending" marker (in one transaction). */
export type TAtMostOnceAlongside = (tx: Prisma.TransactionClient) => Promise<unknown>;

export type TAtMostOnceOptions = {
  /**
   * Runs instead of the callback when an earlier attempt was cut off during the send. Gets the
   * time the "sending" marker was written. It records what is known (for example an audit entry
   * that the message may have gone out); it must not send.
   */
  onCutOff?: (startedAt: Date | null) => Promise<void>;
};

export const markAtMostOnceTaskStarted = async (taskId: string, alongside?: TAtMostOnceAlongside) => {
  await prisma.$transaction(async (tx) => {
    await tx.backgroundJobTask.update({
      where: { id: taskId },
      data: { result: { [STARTED_MARKER_KEY]: new Date().toISOString() } },
    });

    if (alongside) {
      await alongside(tx);
    }
  });
};

export const getAtMostOnceStartedAt = (task: Pick<BackgroundJobTask, 'result'>) => {
  const { result } = task;

  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    return null;
  }

  const value = (result as Record<string, unknown>)[STARTED_MARKER_KEY];

  return typeof value === 'string' ? new Date(value) : null;
};

export const completeCutOffAtMostOnceTask = async (taskId: string, cacheKey: string) => {
  console.warn(`[JOBS:${taskId}] Skipping at-most-once task "${cacheKey}": an earlier attempt was cut off during it`);

  await prisma.backgroundJobTask.update({
    where: { id: taskId },
    data: { status: BackgroundJobStatus.COMPLETED, result: Prisma.JsonNull, completedAt: new Date() },
  });
};

/**
 * `io.runTask(cacheKey, callback, { atMostOnce: true })`, with the callback last. The callback
 * calls `markSending()` right before the side effect (the SMTP call), so work before it (loading,
 * rendering) still runs again after a crash; only a crash during the send itself skips it.
 * `markSending(alongside)` writes `alongside` in the same transaction as the marker (a counter
 * that must move exactly when the send starts).
 */
export const runTaskAtMostOnce = async <T extends Json | void | undefined>(
  io: Pick<JobRunIO, 'runTask'>,
  // The cache key, or the cache key with options.
  task: string | ({ cacheKey: string } & TAtMostOnceOptions),
  callback: (markSending: (alongside?: TAtMostOnceAlongside) => Promise<void>) => Promise<T>,
) => {
  const { cacheKey, ...options } = typeof task === 'string' ? { cacheKey: task } : task;

  return await io.runTask(
    cacheKey,
    async (markSending) =>
      await callback(
        markSending ??
          (async (alongside) => {
            // Providers without at-most-once support: still write what belongs with the send.
            if (alongside) {
              await prisma.$transaction(async (tx) => await alongside(tx));
            }
          }),
      ),
    { atMostOnce: true, onCutOff: options.onCutOff },
  );
};
