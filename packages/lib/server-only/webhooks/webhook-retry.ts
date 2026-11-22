/**
 * Wait before each retry of a failed webhook call: 1 min, 5 min, 30 min, 2 h, 6 h.
 * Six attempts in all, spread over about 8.5 hours, so a receiver that is down for a deploy or
 * a restart still gets the event. The retry sweep runs every minute, so each wait can be up to a
 * minute longer.
 */
export const WEBHOOK_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000];

export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_RETRY_DELAYS_MS.length + 1;

/**
 * When to try again after attempt number `attempt` (1-based) failed, or null when it was the last.
 */
export const getNextWebhookAttemptAt = (attempt: number, now = new Date()): Date | null => {
  const delay = WEBHOOK_RETRY_DELAYS_MS[attempt - 1];

  if (delay === undefined || attempt < 1) {
    return null;
  }

  return new Date(now.getTime() + delay);
};
