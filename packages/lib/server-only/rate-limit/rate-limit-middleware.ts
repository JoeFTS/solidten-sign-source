import type { Context } from 'hono';
import type { MiddlewareHandler } from 'hono/types';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { getIpAddress } from '../../universal/get-ip-address';
import type { createRateLimit, RateLimitCheckResult } from './rate-limit';

/**
 * Solid Ten: every 429 says the same thing (LD3-L1). JSON routes answer
 * `{ "error": TOO_MANY_REQUESTS_MESSAGE, "code": "TOO_MANY_REQUESTS" }` with Retry-After and the
 * X-RateLimit headers; tRPC answers its own error shape with code -32029 (trpc-rate-limit.ts,
 * and trpc.ts for limits checked inside a procedure).
 */
export const TOO_MANY_REQUESTS_MESSAGE = 'Too many requests. Wait a moment, then try again.';

export const TOO_MANY_REQUESTS_BODY = { error: TOO_MANY_REQUESTS_MESSAGE, code: 'TOO_MANY_REQUESTS' } as const;

/**
 * Solid Ten: seconds until a refused caller may try again, for Retry-After.
 */
export const getRetryAfterSeconds = (reset: Date) => Math.max(1, Math.ceil((reset.getTime() - Date.now()) / 1000));

/** Solid Ten: a Retry-After header for a refusal, to pass as AppError `headers` or on a Response. */
export const getRetryAfterHeaders = (reset: Date): Record<string, string> => ({
  'Retry-After': String(getRetryAfterSeconds(reset)),
});

/**
 * Set rate limit response headers on a Hono context.
 */
const setRateLimitHeaders = (c: Context, result: RateLimitCheckResult) => {
  c.header('X-RateLimit-Limit', String(result.limit));
  c.header('X-RateLimit-Remaining', String(result.remaining));
  c.header('X-RateLimit-Reset', String(Math.ceil(result.reset.getTime() / 1000)));
};

/**
 * Create a Hono middleware that applies rate limiting to a route.
 *
 * Uses IP address for identification. Optionally accepts an identifier
 * function for per-user/per-entity limiting.
 */
export const createRateLimitMiddleware = (
  limiter: ReturnType<typeof createRateLimit>,
  options?: { identifierFn?: (c: Context) => string | undefined },
): MiddlewareHandler => {
  return async (c, next) => {
    let ip: string;

    try {
      ip = getIpAddress(c.req.raw);
    } catch {
      ip = 'unknown';
    }

    const identifier = options?.identifierFn?.(c);

    const result = await limiter.check({ ip, identifier });

    setRateLimitHeaders(c, result);

    if (result.isLimited) {
      c.header('Retry-After', String(Math.max(1, Math.ceil((result.reset.getTime() - Date.now()) / 1000))));

      return c.json(TOO_MANY_REQUESTS_BODY, 429);
    }

    await next();
  };
};

/**
 * Helper for inline rate limit checks in Hono auth routes.
 *
 * Returns a 429 Response with rate limit headers if limited, or `null` if allowed.
 */
export const rateLimitResponse = (c: Context, result: RateLimitCheckResult): Response | null => {
  setRateLimitHeaders(c, result);

  if (result.isLimited) {
    c.header('Retry-After', String(Math.max(1, Math.ceil((result.reset.getTime() - Date.now()) / 1000))));

    return c.json(TOO_MANY_REQUESTS_BODY, 429);
  }

  return null;
};

/**
 * Helper for inline rate limit checks in tRPC routes.
 *
 * Throws an AppError with TOO_MANY_REQUESTS code if limited.
 */
export const assertRateLimit = (result: RateLimitCheckResult): void => {
  if (result.isLimited) {
    const retryAfter = String(Math.max(1, Math.ceil((result.reset.getTime() - Date.now()) / 1000)));

    throw new AppError(AppErrorCode.TOO_MANY_REQUESTS, {
      message: TOO_MANY_REQUESTS_MESSAGE,
      userMessage: TOO_MANY_REQUESTS_MESSAGE,
      headers: {
        'X-RateLimit-Limit': String(result.limit),
        'X-RateLimit-Remaining': String(result.remaining),
        'X-RateLimit-Reset': String(Math.ceil(result.reset.getTime() / 1000)),
        'Retry-After': retryAfter,
      },
    });
  }
};
