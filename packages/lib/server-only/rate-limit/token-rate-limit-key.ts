import { createHash } from 'node:crypto';

/**
 * Solid Ten Sign (S-L6): a rate-limit identifier for a signing link. The RateLimit table
 * keeps only a one-way hash, so a database read never yields a working link.
 */
export const getTokenRateLimitKey = (token: string) =>
  `token:${createHash('sha256').update(token).digest('hex').slice(0, 32)}`;
