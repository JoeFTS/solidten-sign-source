import { prisma } from '@documenso/prisma';
import { BackgroundJobStatus } from '@prisma/client';
import type { MiddlewareHandler } from 'hono';

import { killPdfChildren } from '../../server-only/pdf-child/run-pdf-operation';
import { env } from '../../utils/env';
import { getJobSlotStats } from './job-slots';

/**
 * Solid Ten: a restart (deploy, `docker stop`) loses and delays no background job (FS3-M1).
 *
 * Before: the app did nothing on SIGTERM. In the container the shell that started node was
 * process 1 and did not pass SIGTERM on; Docker killed node after 10 s. Every job in flight was
 * dropped, left PROCESSING, and after the restart counted as a possible crash.
 *
 * Now, on SIGTERM or SIGINT (once):
 * - the HTTP server stops taking new connections;
 * - job runs that arrive are refused before they are claimed; their rows are made due at once,
 *   so the next process's startup sweep runs them; the recovery sweep of this process stops;
 * - jobs that have started may finish, for at most NEXT_PRIVATE_ST_SHUTDOWN_DRAIN_MS (default
 *   25 s); jobs still waiting for a job slot do not start;
 * - rows still running then are marked interrupted, not crashed: back to PENDING, due at once,
 *   the attempt given back, no cut-off counted;
 * - PDF children are stopped, the database connection closed, the process ends with code 0.
 * Docker's stop timeout must be longer than the drain (compose: stop_grace_period 40s).
 */
export const DEFAULT_SHUTDOWN_DRAIN_MS = 25_000;

type TShutdownState = { isDraining: boolean; inFlight: Map<string, number> };

declare global {
  // eslint-disable-next-line no-var
  var __solidten_shutdown__: TShutdownState | undefined;
}

const state = (): TShutdownState => {
  globalThis.__solidten_shutdown__ ??= { isDraining: false, inFlight: new Map() };

  return globalThis.__solidten_shutdown__;
};

export const isDraining = () => state().isDraining;

export const getDrainMs = () => {
  const value = Number(env('NEXT_PRIVATE_ST_SHUTDOWN_DRAIN_MS'));

  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_SHUTDOWN_DRAIN_MS;
};

/** Run one job request, counted as in flight until it has answered. */
export const trackJobRequest = async <T>(jobId: string | undefined, run: () => Promise<T>): Promise<T> => {
  if (!jobId) {
    return await run();
  }

  const { inFlight } = state();
  inFlight.set(jobId, (inFlight.get(jobId) ?? 0) + 1);

  try {
    return await run();
  } finally {
    const left = (inFlight.get(jobId) ?? 1) - 1;

    if (left > 0) {
      inFlight.set(jobId, left);
    } else {
      inFlight.delete(jobId);
    }
  }
};

/** A row the next process should run at once: due now, nothing counted. */
const makeDueNow = async (ids: string[], status: BackgroundJobStatus) => {
  if (ids.length === 0) {
    return 0;
  }

  let count = 0;

  for (const id of ids) {
    const row = await prisma.backgroundJob.findFirst({ where: { id, status }, select: { retried: true } });

    if (!row) {
      continue;
    }

    const updated = await prisma.backgroundJob.updateMany({
      where: { id, status },
      data: {
        status: BackgroundJobStatus.PENDING,
        nextRunAt: new Date(),
        // The interrupted run's attempt is given back (a first run was not counted).
        ...(status === BackgroundJobStatus.PROCESSING && row.retried > 0 ? { retried: { decrement: 1 } } : {}),
      },
    });

    count += updated.count;
  }

  return count;
};

/** In front of /api/jobs: refuses new runs while draining, counts the runs in flight. */
export const createJobShutdownMiddleware = (): MiddlewareHandler => async (c, next) => {
  const jobId = c.req.header('x-job-id');

  if (isDraining()) {
    if (jobId) {
      await makeDueNow([jobId], BackgroundJobStatus.PENDING).catch(() => 0);
    }

    return c.text('Shutting down', 503);
  }

  await trackJobRequest(jobId, async () => await next());
};

/** Stop taking job runs, wait for those in flight (at most `timeoutMs`), mark the rest interrupted. */
export const drainJobs = async ({ timeoutMs = getDrainMs() }: { timeoutMs?: number } = {}) => {
  const current = state();
  current.isDraining = true;

  const startedInFlight = current.inFlight.size;
  const deadline = Date.now() + timeoutMs;

  // Wait for the runs that have started; a run still waiting for a job slot has touched nothing
  // and starts no more (job-slots.ts), so it is marked interrupted at once.
  const isStartedRunLeft = () => current.inFlight.size - getJobSlotStats().waiting > 0;

  while (isStartedRunLeft() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const left = [...current.inFlight.keys()];
  const interrupted = await makeDueNow(left, BackgroundJobStatus.PROCESSING).catch((error: unknown) => {
    console.error('[SHUTDOWN]: Could not mark the interrupted jobs', error);

    return 0;
  });

  return { startedInFlight, finished: startedInFlight - left.length, interrupted };
};

/** Install the SIGTERM / SIGINT handler (production server entry, main.js). */
export const installGracefulShutdown = (server?: { close: (callback?: (error?: Error) => void) => unknown }) => {
  let isStopping = false;

  const stop = async (signal: string) => {
    if (isStopping) {
      return;
    }

    isStopping = true;
    console.log(
      `[SHUTDOWN]: ${signal}: no new requests or job runs; waiting up to ${getDrainMs()} ms for jobs in flight`,
    );

    server?.close();

    const result = await drainJobs();

    console.log(
      `[SHUTDOWN]: ${result.finished} of ${result.startedInFlight} job run(s) finished; ` +
        `${result.interrupted} marked interrupted (they run again at the next start, not counted)`,
    );

    killPdfChildren();
    await prisma.$disconnect().catch(() => {});

    process.exit(0);
  };

  process.once('SIGTERM', () => void stop('SIGTERM'));
  process.once('SIGINT', () => void stop('SIGINT'));
};
