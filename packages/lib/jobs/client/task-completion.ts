import { prisma } from '@documenso/prisma';
import { BackgroundJobStatus, Prisma } from '@prisma/client';

/**
 * Solid Ten: record that a task's callback finished (FS3-L1).
 *
 * Before, a failure of this one update (a connection-pool timeout in an expiry burst) went to the
 * task's failure path: the at-most-once marker was cleared and a retry counted, so a notice that
 * had been sent went out again. The write is now retried; when it still fails, the error goes up
 * with the task row untouched (its marker in place).
 */
export const RECORD_COMPLETION_WAITS_MS = [250, 1_000, 3_000];

export const recordTaskCompleted = async ({
  taskId,
  jobId,
  result,
}: {
  taskId: string;
  jobId: string;
  result: unknown;
}) => {
  let lastError: unknown;

  for (let attempt = 0; attempt <= RECORD_COMPLETION_WAITS_MS.length; attempt++) {
    try {
      return await prisma.backgroundJobTask.update({
        where: { id: taskId, jobId },
        data: {
          status: BackgroundJobStatus.COMPLETED,
          // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
          result: result === null || result === undefined ? Prisma.JsonNull : (result as Prisma.InputJsonValue),
          completedAt: new Date(),
        },
      });
    } catch (error) {
      lastError = error;

      if (attempt < RECORD_COMPLETION_WAITS_MS.length) {
        await new Promise((resolve) => setTimeout(resolve, RECORD_COMPLETION_WAITS_MS[attempt]));
      }
    }
  }

  console.error(
    `[JOBS:${taskId}] The task ran, but its completion could not be recorded; left as it is (an at-most-once task keeps its marker)`,
    lastError,
  );

  throw lastError;
};
