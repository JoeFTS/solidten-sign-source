import { AsyncLocalStorage } from 'node:async_hooks';

import { createServerBusyError } from '../../errors/server-busy';

/**
 * Solid Ten: one heavy PDF operation at a time per process (LD2-A).
 *
 * Two 15 MB uploads at once kept the Node thread busy (PDF work and long garbage-collection
 * pauses) long enough that the other request's database transaction passed its timeout and
 * failed with a 500. Heavy work (normalising an upload, rendering or sealing a large document)
 * now runs through this queue: a second large request waits for the first instead of failing.
 *
 * - runHeavyPdfWork queues work on at least HEAVY_PDF_BYTES (and holds the slot for the caller's
 *   transaction). Parsing an upload always takes a slot, at every size (AUD-2, isolated-pdf.ts):
 *   the threshold decides how long a caller holds the slot, never whether parsing is isolated.
 * - Re-entrant: work started inside a held slot (sealing calls the upload code) runs at once.
 * - Bounded for requests: at most MAX_WAITING requests wait, each at most MAX_WAIT_MS. Beyond that
 *   the caller gets SERVER_BUSY (HTTP 503, "The server is busy, try again", Retry-After).
 *   Background jobs (sealing) pass `waitForTurn` and wait without a bound instead: a refusal
 *   would only burn the job's retries.
 * - A caller holds its slot for its whole heavy section, including the short database
 *   transaction that follows its PDF work, so no other heavy work can stall that transaction.
 */
export const HEAVY_PDF_BYTES = 2 * 1024 * 1024;
export const HEAVY_PDF_MAX_WAITING = 4;
export const HEAVY_PDF_MAX_WAIT_MS = 120_000;
type Waiter = { start: () => void; timer: NodeJS.Timeout };

export const createHeavyWorkQueue = ({
  maxWaiting = HEAVY_PDF_MAX_WAITING,
  maxWaitMs = HEAVY_PDF_MAX_WAIT_MS,
}: {
  maxWaiting?: number;
  maxWaitMs?: number;
} = {}) => {
  const slot = new AsyncLocalStorage<true>();
  const waiting: Waiter[] = [];
  let isBusy = false;

  const release = () => {
    const next = waiting.shift();

    if (next) {
      clearTimeout(next.timer);
      next.start();

      return;
    }

    isBusy = false;
  };

  const acquire = async (waitForTurn: boolean) => {
    if (!isBusy) {
      isBusy = true;

      return;
    }

    if (!waitForTurn && waiting.length >= maxWaiting) {
      throw createServerBusyError();
    }

    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        start: resolve,
        timer: setTimeout(() => {
          if (waitForTurn) {
            return;
          }

          const index = waiting.indexOf(waiter);

          if (index !== -1) {
            waiting.splice(index, 1);
          }

          reject(createServerBusyError());
        }, maxWaitMs),
      };

      waiting.push(waiter);
    });
  };

  return {
    /** Run `work` alone among heavy work. */
    run: async <T>(work: () => Promise<T>, { waitForTurn = false }: { waitForTurn?: boolean } = {}): Promise<T> => {
      if (slot.getStore()) {
        return await work();
      }

      await acquire(waitForTurn);

      try {
        return await slot.run(true, work);
      } finally {
        release();
      }
    },
    stats: () => ({ isBusy, waiting: waiting.length }),
  };
};

declare global {
  // eslint-disable-next-line no-var
  var __solidten_heavy_pdf_queue__: ReturnType<typeof createHeavyWorkQueue> | undefined;
}

/**
 * One queue per process. The production server is two bundles (the Hono/tRPC server and the
 * React Router build), each with its own copy of this module; a module-level queue would be two
 * queues, and /api/health (a route) would watch the wrong one (RT4-L1). The queue lives on
 * globalThis, as upstream keeps the BullMQ provider (jobs/client/bullmq.ts).
 */
const getProcessHeavyPdfQueue = () => {
  if (!globalThis.__solidten_heavy_pdf_queue__) {
    globalThis.__solidten_heavy_pdf_queue__ = createHeavyWorkQueue();
  }

  return globalThis.__solidten_heavy_pdf_queue__;
};

export const heavyPdfQueue = getProcessHeavyPdfQueue();

/** Run `work` through the queue when it handles at least HEAVY_PDF_BYTES, else at once. */
export const runHeavyPdfWork = async <T>(
  bytes: number,
  work: () => Promise<T>,
  options: { waitForTurn?: boolean } = {},
): Promise<T> => (bytes >= HEAVY_PDF_BYTES ? await heavyPdfQueue.run(work, options) : await work());
