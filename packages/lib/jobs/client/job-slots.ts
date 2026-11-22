import { prisma } from '@documenso/prisma';
import { BackgroundJobStatus } from '@prisma/client';

import { env } from '../../utils/env';

/**
 * Solid Ten: background jobs run at most NEXT_PRIVATE_ST_JOB_CONCURRENCY at a time in this process
 * (default 6), in the order they arrive (FS3-L1).
 *
 * Before, a burst (an expiry sweep, a recovery after a crash) started every job at once; each holds
 * database connections, the pool (Prisma's default: 2 x CPUs + 1, 21 on the test Mac) ran dry and
 * web requests waited for a connection until Prisma's pool timeout (10 s), then failed (P2024; a
 * 503 "temporarily unable to save" since DISK-L1). The default leaves most of the pool to web
 * requests; keep it well below the pool size (connection_limit in the database URL).
 *
 * A job waits for its slot after it has been claimed. While it waits, its row's updatedAt is
 * refreshed every minute, and once more when it starts, so the recovery sweep does not take a
 * waiting job for a cut-off one.
 */
export const DEFAULT_JOB_CONCURRENCY = 6;
/** How often a waiting or running job refreshes its row (well under the 5 minute timeout). */
export const WAITING_HEARTBEAT_MS = 60_000;

type TSlots = { running: number; maxRunning: number; queue: Array<() => void> };

declare global {
  // eslint-disable-next-line no-var
  var __solidten_job_slots__: TSlots | undefined;
  // eslint-disable-next-line no-var
  var __solidten_receiver_job_slots__: TSlots | undefined;
}

const slots = (): TSlots => {
  globalThis.__solidten_job_slots__ ??= { running: 0, maxRunning: 0, queue: [] };

  return globalThis.__solidten_job_slots__;
};

/**
 * Solid Ten (AUD-25): jobs whose run time an outside receiver controls (webhook delivery waits for
 * the receiver's answer) take a share first, then a slot. The share is half the slots, so webhooks
 * to a slow receiver never hold every slot and signing mail and seals always have room (with a
 * limit of 2 or more).
 */
const RECEIVER_BOUND_JOB_IDS = new Set(['internal.execute-webhook']);

const receiverSlots = (): TSlots => {
  globalThis.__solidten_receiver_job_slots__ ??= { running: 0, maxRunning: 0, queue: [] };

  return globalThis.__solidten_receiver_job_slots__;
};

export const getJobConcurrency = () => {
  const value = Number(env('NEXT_PRIVATE_ST_JOB_CONCURRENCY'));

  return Number.isInteger(value) && value >= 1 ? value : DEFAULT_JOB_CONCURRENCY;
};

export const getReceiverBoundJobConcurrency = () => Math.max(1, Math.floor(getJobConcurrency() / 2));

export const getJobSlotStats = () => {
  const { running, maxRunning, queue } = slots();
  const receiver = receiverSlots();

  return {
    limit: getJobConcurrency(),
    running,
    // Every run that has not started yet, also those waiting for the webhook share.
    waiting: queue.length + receiver.queue.length,
    maxRunning,
    webhookLimit: getReceiverBoundJobConcurrency(),
    webhookRunning: receiver.running,
  };
};

const take = (state: TSlots) => {
  state.running++;
  state.maxRunning = Math.max(state.maxRunning, state.running);
};

const touch = async (jobId: string) =>
  await prisma.backgroundJob
    .updateMany({ where: { id: jobId, status: BackgroundJobStatus.PROCESSING }, data: { updatedAt: new Date() } })
    .catch(() => null);

const acquire = async (state: TSlots, limit: number, jobId: string): Promise<() => void> => {
  let isReleased = false;

  const release = () => {
    if (isReleased) {
      return;
    }

    isReleased = true;
    state.running--;

    // A process that shuts down starts no more jobs: the waiting ones are marked interrupted and
    // run at the next start (graceful-shutdown.ts).
    if (globalThis.__solidten_shutdown__?.isDraining) {
      return;
    }

    const next = state.queue.shift();

    if (next) {
      next();
    }
  };

  if (state.running < limit && state.queue.length === 0) {
    take(state);

    return release;
  }

  const heartbeat = setInterval(() => void touch(jobId), WAITING_HEARTBEAT_MS);

  await new Promise<void>((resolve) => {
    state.queue.push(() => {
      take(state);
      resolve();
    });
  });

  clearInterval(heartbeat);

  // The timeout of a running job counts from now.
  await touch(jobId);

  return release;
};

/**
 * Wait for a slot for the claimed job `jobId` (of job definition `definitionId`); returns the
 * function that frees it.
 */
export const waitForJobSlot = async (jobId: string, definitionId?: string): Promise<() => void> => {
  const releaseShare =
    definitionId && RECEIVER_BOUND_JOB_IDS.has(definitionId)
      ? await acquire(receiverSlots(), getReceiverBoundJobConcurrency(), jobId)
      : null;

  const releaseSlot = await acquire(slots(), getJobConcurrency(), jobId);

  return () => {
    releaseSlot();
    releaseShare?.();
  };
};

/**
 * Run `run` in a job slot. While it runs, its row's updatedAt is refreshed every minute too: a job
 * may run longer than its PROCESSING timeout (a large seal waits for the heavy-PDF slot inside its
 * run, then up to 5 minutes in the PDF child), and a row that stopped being refreshed is what the
 * recovery sweep takes for a cut-off one. Without it a long run was re-queued and started a second
 * time while the first still ran. `heartbeatMs` is for tests.
 */
export const withJobSlot = async <T>(
  {
    jobId,
    definitionId,
    heartbeatMs = WAITING_HEARTBEAT_MS,
  }: { jobId: string; definitionId?: string; heartbeatMs?: number },
  run: () => Promise<T>,
): Promise<T> => {
  const release = await waitForJobSlot(jobId, definitionId);
  const heartbeat = setInterval(() => void touch(jobId), heartbeatMs);

  try {
    return await run();
  } finally {
    clearInterval(heartbeat);
    release();
  }
};
