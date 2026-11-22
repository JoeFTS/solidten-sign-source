import { prisma } from '@documenso/prisma';

/**
 * Solid Ten Sign: daily abuse ceilings (emails to strangers, texts, verification codes).
 *
 * Unlike `createRateLimit`, these are not turned off by DANGEROUS_BYPASS_RATE_LIMITS: they
 * cap what a stranger can make the server send, and the tests check them like any other
 * rule. They share the RateLimit table (one row per key and UTC day); the cleanup job
 * removes rows older than a day.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export const getDailyQuotaBucket = (now = Date.now()) => new Date(now - (now % DAY_MS));

/** Solid Ten: when today's daily quotas start again (for Retry-After). */
export const getNextDailyQuotaReset = (now = Date.now()) => new Date(getDailyQuotaBucket(now).getTime() + DAY_MS);

export type TConsumeDailyQuotaOptions = {
  /** Groups the counters, like a rate limit action. */
  action: string;
  key: string;
  max: number;
  count?: number;
};

/**
 * Take `count` units from today's quota. Returns false, and takes nothing, when that
 * would go over `max`. Safe under concurrency: the counter is incremented first.
 */
export const consumeDailyQuota = async ({ action, key, max, count = 1 }: TConsumeDailyQuotaOptions) => {
  if (count <= 0) {
    return true;
  }

  const bucket = getDailyQuotaBucket();

  const row = await prisma.rateLimit.upsert({
    where: { key_action_bucket: { key, action, bucket } },
    create: { key, action, bucket, count },
    update: { count: { increment: count } },
  });

  if (row.count > max) {
    await prisma.rateLimit.update({
      where: { key_action_bucket: { key, action, bucket } },
      data: { count: { decrement: count } },
    });

    return false;
  }

  return true;
};

/** Give back units taken for something that did not happen. */
export const releaseDailyQuota = async ({ action, key, count = 1 }: Omit<TConsumeDailyQuotaOptions, 'max'>) => {
  if (count <= 0) {
    return;
  }

  await prisma.rateLimit.updateMany({
    where: { key, action, bucket: getDailyQuotaBucket(), count: { gte: count } },
    data: { count: { decrement: count } },
  });
};

/**
 * Read a positive whole number from an environment variable, or the default.
 */
export const readQuotaEnv = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseInt(value ?? '', 10);

  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};
