import { describe, expect, it } from 'vitest';

import { getNextWebhookAttemptAt, WEBHOOK_MAX_ATTEMPTS } from './webhook-retry';

const NOW = new Date('2026-11-20T10:00:00Z');

describe('getNextWebhookAttemptAt', () => {
  it('spaces retries out instead of retrying at once', () => {
    expect(getNextWebhookAttemptAt(1, NOW)?.toISOString()).toBe('2026-11-20T10:01:00.000Z');
    expect(getNextWebhookAttemptAt(2, NOW)?.toISOString()).toBe('2026-11-20T10:05:00.000Z');
    expect(getNextWebhookAttemptAt(3, NOW)?.toISOString()).toBe('2026-11-20T10:30:00.000Z');
    expect(getNextWebhookAttemptAt(5, NOW)?.toISOString()).toBe('2026-11-20T16:00:00.000Z');
  });

  it('stops after the last attempt', () => {
    expect(WEBHOOK_MAX_ATTEMPTS).toBe(6);
    expect(getNextWebhookAttemptAt(6, NOW)).toBeNull();
    expect(getNextWebhookAttemptAt(0, NOW)).toBeNull();
  });
});
