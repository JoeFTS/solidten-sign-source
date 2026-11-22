import { describe, expect, it } from 'vitest';

import { buildSmsIdempotencyKey } from './sms-availability';

describe('buildSmsIdempotencyKey', () => {
  it('gives the same recipient a new key once their link token changes', () => {
    const before = buildSmsIdempotencyKey('SIGNING_REQUEST', { id: 7, token: 'old-token' });
    const after = buildSmsIdempotencyKey('SIGNING_REQUEST', { id: 7, token: 'new-token' });

    expect(before).not.toBe(after);
    expect(buildSmsIdempotencyKey('SIGNING_REQUEST', { id: 7, token: 'old-token' })).toBe(before);
  });

  it('never puts the token itself in the key', () => {
    const key = buildSmsIdempotencyKey('REMINDER', { id: 7, token: 'secret-link-token' }, 2);

    expect(key).not.toContain('secret-link-token');
    expect(key).toMatch(/^REMINDER:7:[0-9a-f]{12}:2$/);
  });
});
