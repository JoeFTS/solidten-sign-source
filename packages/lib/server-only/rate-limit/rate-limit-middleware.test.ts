import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import type { createRateLimit } from './rate-limit';
import { assertRateLimit, createRateLimitMiddleware, rateLimitResponse } from './rate-limit-middleware';

const limitedResult = { isLimited: true, limit: 10, remaining: 0, reset: new Date(Date.now() + 30_000) };

// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
const limitedLimiter = { check: async () => await Promise.resolve(limitedResult) } as unknown as ReturnType<
  typeof createRateLimit
>;

const expectSame429 = async (response: Response) => {
  expect(response.status).toBe(429);
  expect(await response.json()).toEqual({
    error: 'Too many requests. Wait a moment, then try again.',
    code: 'TOO_MANY_REQUESTS',
  });
  expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0);
  expect(response.headers.get('X-RateLimit-Limit')).toBe('10');
};

describe('429 answers (LD3-L1)', () => {
  it('the route middleware (API v1/v2, uploads, AI, embed) answers the one 429 shape', async () => {
    const app = new Hono();
    app.use('*', createRateLimitMiddleware(limitedLimiter));
    app.get('/x', (c) => c.text('ok'));

    await expectSame429(await app.request('/x'));
  });

  it('inline checks (sign-in links, passkeys, field files) answer the same', async () => {
    const app = new Hono();
    app.get('/x', (c) => rateLimitResponse(c, limitedResult) ?? c.text('ok'));

    await expectSame429(await app.request('/x'));
  });

  it('a limit checked inside a procedure carries the same message and Retry-After', () => {
    expect(() => assertRateLimit(limitedResult)).toThrow(
      expect.objectContaining({
        code: 'TOO_MANY_REQUESTS',
        message: 'Too many requests. Wait a moment, then try again.',
        headers: expect.objectContaining({ 'Retry-After': expect.any(String) }),
      }),
    );
  });
});
