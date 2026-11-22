import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PROCESSING_TIMEOUT_MS,
  getMaxRetries,
  getNextRunAt,
  getProcessingTimeoutMs,
  SIGNIN_LINK_RETRY_JOB_ID,
} from './job-retry-policy';
import { hasSpentAttemptBudget } from './local-recovery';

describe('job retry policy', () => {
  it('gives long-running jobs a longer processing timeout than the default', () => {
    expect(getProcessingTimeoutMs('internal.process-signing-reminder')).toBe(DEFAULT_PROCESSING_TIMEOUT_MS);
    expect(getProcessingTimeoutMs('internal.seal-document')).toBe(DEFAULT_PROCESSING_TIMEOUT_MS);
    expect(getProcessingTimeoutMs('internal.bulk-send-template')).toBeGreaterThan(DEFAULT_PROCESSING_TIMEOUT_MS);
  });

  it('spends the attempt budget after maxRetries retries', () => {
    expect(hasSpentAttemptBudget({ retried: 0, maxRetries: 3 })).toBe(false);
    expect(hasSpentAttemptBudget({ retried: 2, maxRetries: 3 })).toBe(false);
    expect(hasSpentAttemptBudget({ retried: 3, maxRetries: 3 })).toBe(true);
  });

  it('spaces email retries 1, 5, 15, 60 and 240 minutes apart, and no other job', () => {
    const now = new Date('2026-11-20T12:00:00Z');
    const minutesAfter = (date: Date | null) => (date ? (date.getTime() - now.getTime()) / 60_000 : null);

    expect(
      [0, 1, 2, 3, 4].map((retried) => minutesAfter(getNextRunAt('send.signing.requested.email', retried, now))),
    ).toEqual([1, 5, 15, 60, 240]);
    expect(getMaxRetries('send.signing.requested.email')).toBe(5);

    expect(getNextRunAt('internal.seal-document', 0, now)).toBeNull();
    expect(getMaxRetries('internal.seal-document')).toBeUndefined();
  });

  it('retries a sign-in link for about 20 minutes only', () => {
    const now = new Date('2026-11-20T12:00:00Z');

    expect(getMaxRetries(SIGNIN_LINK_RETRY_JOB_ID)).toBe(3);
    expect((getNextRunAt(SIGNIN_LINK_RETRY_JOB_ID, 2, now)?.getTime() ?? 0) - now.getTime()).toBe(15 * 60_000);
  });
});
