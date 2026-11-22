import { prisma } from '@documenso/prisma';
import type { Prisma } from '@prisma/client';

import { env } from '../../utils/env';
import { jobs } from '../client';
import { getMaxRetries, SIGNIN_LINK_RETRY_JOB_ID } from './job-retry-policy';

/**
 * Solid Ten: queue a job to start after `delayMs`. With the local provider the row waits with a
 * nextRunAt and the recovery sweep starts it; other providers run it now.
 */
const scheduleDelayedJob = async (options: {
  jobId: string;
  name: string;
  version: string;
  payload: Prisma.InputJsonValue;
  delayMs: number;
}) => {
  const provider = env('NEXT_PRIVATE_JOBS_PROVIDER');

  if (provider === 'inngest' || provider === 'bullmq') {
    // biome-ignore lint/suspicious/noExplicitAny: the trigger name is checked by the caller.
    await jobs.triggerJob({ name: options.jobId, payload: options.payload } as any);

    return;
  }

  await prisma.backgroundJob.create({
    data: {
      jobId: options.jobId,
      name: options.name,
      version: options.version,
      payload: options.payload,
      maxRetries: getMaxRetries(options.jobId),
      nextRunAt: new Date(Date.now() + options.delayMs),
    },
  });
};

/** The sign-in link email failed when it was asked for: try again in a minute (then 5, 15). */
export const scheduleSigninLinkRetry = async ({ email }: { email: string }) =>
  await scheduleDelayedJob({
    jobId: SIGNIN_LINK_RETRY_JOB_ID,
    name: 'Retry Sign-in Link Email',
    version: '1.0.0',
    payload: { email },
    delayMs: 60_000,
  });
