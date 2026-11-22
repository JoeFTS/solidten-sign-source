import { prisma } from '@documenso/prisma';
import { Prisma } from '@prisma/client';

import { logger } from '../../utils/logger';
import { getDailyQuotaBucket } from './daily-quota';

/**
 * Solid Ten Sign: when a server-wide daily cap is reached, every form or text on the
 * server stops until the next UTC day, and someone with many addresses can cause that on
 * purpose. Staff hear about it: one notice per cap per day to the organisation admins,
 * and /api/health lists the caps reached today.
 */

export const SERVER_CAPS = {
  PUBLIC_FORM_CODES: 'Public-form verification code emails',
  SMS: 'Text messages',
} as const;

export type TServerCap = keyof typeof SERVER_CAPS;

const CAP_REACHED_ACTION = 'st.server-cap-reached';

/**
 * Record that a cap was reached. Only the first call of the day for a cap sends the
 * notice; the INSERT decides, so parallel callers send it once. Never throws.
 */
export const recordServerCapReached = async (cap: TServerCap) => {
  try {
    await prisma.rateLimit.create({
      data: { key: `cap:${cap}`, action: CAP_REACHED_ACTION, bucket: getDailyQuotaBucket(), count: 1 },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return;
    }

    logger.error({ msg: '[CAPS] Could not record a reached cap', cap, error });

    return;
  }

  logger.warn({ msg: '[CAPS] A server-wide daily cap was reached', cap });

  // Loaded on use: the senders that call this do not need the email code up front.
  try {
    const { notifyAdminsOfServerCap } = await import('./server-cap-notice');

    await notifyAdminsOfServerCap(cap);
  } catch (error) {
    logger.error({ msg: '[CAPS] Could not email admins about a reached cap', cap, error });
  }
};

/** The caps reached today (UTC), for /api/health. */
export const getCapsReachedToday = async (): Promise<TServerCap[]> => {
  const rows = await prisma.rateLimit.findMany({
    where: { action: CAP_REACHED_ACTION, bucket: getDailyQuotaBucket() },
    select: { key: true },
  });

  return rows.map((row) => row.key.replace(/^cap:/, '')).filter((cap): cap is TServerCap => cap in SERVER_CAPS);
};
