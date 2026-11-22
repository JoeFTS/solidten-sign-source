/**
 * Solid Ten: per-job retry rules for the local job provider.
 *
 * - processingTimeoutMs: a PROCESSING row older than this was cut off (crash, out of memory,
 *   restart). The recovery sweep puts it back to PENDING and runs it again.
 * - backoffMinutes: after a failed attempt the job waits this long before the next one (the
 *   recovery sweep starts it when nextRunAt has passed). Without it, a failed job is retried at
 *   once, as upstream does. The list length is the number of retries.
 *
 * Every job keeps an attempt budget (BackgroundJob.maxRetries). A job that keeps crashing the
 * process uses one attempt per crash and is marked FAILED when the budget is spent.
 */

export const DEFAULT_PROCESSING_TIMEOUT_MS = 5 * 60_000;

/**
 * Jobs that may legitimately run for a long time. The seal keeps the default: a second seal run
 * that overlaps a slow first one stops at its conditional status update (R-C1), so a short
 * timeout costs CPU at worst, and a cut-off seal resumes in minutes instead of 15 to 30.
 */
const PROCESSING_TIMEOUT_MS: Record<string, number> = {
  'internal.bulk-send-template': 60 * 60_000,
  'internal.admin-delete-organisation': 60 * 60_000,
  // A retention run handles at most 50 documents (about 5 s for 50 in the failure retest), and
  // every step is safe to repeat, so an overlapping re-run costs work, not correctness. A crashed
  // run used to hold up the rest of a chained purge for 30 minutes (FS2-L5).
  'internal.process-retention': 10 * 60_000,
  'internal.retention-sweep': 10 * 60_000,
};

/** Email jobs: a mail server outage of up to about five hours does not lose the email. */
export const EMAIL_BACKOFF_MINUTES = [1, 5, 15, 60, 240];

/** A sign-in link is wanted now. Each retry mails a fresh link (15 minute life), so the person
 * who asked gets one within about 20 minutes or not at all. */
export const SIGNIN_LINK_BACKOFF_MINUTES = [1, 5, 15];

export const SIGNIN_LINK_RETRY_JOB_ID = 'send.solidten.signin.link.retry';

export const getProcessingTimeoutMs = (jobId: string) => PROCESSING_TIMEOUT_MS[jobId] ?? DEFAULT_PROCESSING_TIMEOUT_MS;

export const isEmailJob = (jobId: string) => jobId.startsWith('send.');

export const getBackoffMinutes = (jobId: string): number[] | null => {
  if (jobId === SIGNIN_LINK_RETRY_JOB_ID) {
    return SIGNIN_LINK_BACKOFF_MINUTES;
  }

  if (isEmailJob(jobId)) {
    return EMAIL_BACKOFF_MINUTES;
  }

  return null;
};

/** The attempt budget for a new row (retries after the first attempt). */
export const getMaxRetries = (jobId: string): number | undefined => getBackoffMinutes(jobId)?.length;

/**
 * When the next attempt may start, after `retried` retries have already been used.
 * Returns null when the job has no backoff (retry at once).
 */
export const getNextRunAt = (jobId: string, retried: number, now = new Date()): Date | null => {
  const backoff = getBackoffMinutes(jobId);

  if (!backoff) {
    return null;
  }

  const minutes = backoff[Math.min(retried, backoff.length - 1)];

  return new Date(now.getTime() + minutes * 60_000);
};
