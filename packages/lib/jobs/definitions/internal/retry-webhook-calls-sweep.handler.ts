import { prisma } from '@documenso/prisma';

import { jobs } from '../../client';
import type { JobRunIO } from '../../client/_internal/job';
import type { TRetryWebhookCallsSweepJobDefinition } from './retry-webhook-calls-sweep';

const BATCH_SIZE = 100;

/**
 * Solid Ten: a claimed call keeps a lease instead of `nextAttemptAt = null`. The retry job clears
 * it when it writes the new attempt row. When the job is lost (crash before it ran), the lease
 * ends and the next sweep claims the call again.
 */
const RETRY_LEASE_MS = 10 * 60_000;

const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const run = async ({ io }: { payload: TRetryWebhookCallsSweepJobDefinition; io: JobRunIO }) => {
  const now = new Date();

  const dueCalls = await prisma.webhookCall.findMany({
    where: { nextAttemptAt: { lte: now } },
    orderBy: { nextAttemptAt: 'asc' },
    take: BATCH_SIZE,
    select: {
      id: true,
      event: true,
      attempt: true,
      requestBody: true,
      webhookId: true,
      webhook: { select: { enabled: true } },
    },
  });

  for (const call of dueCalls) {
    // Claim the call so a second sweep on another instance cannot retry it too.
    const claimed = await prisma.webhookCall.updateMany({
      where: { id: call.id, nextAttemptAt: { lte: now } },
      data: { nextAttemptAt: call.webhook.enabled ? new Date(now.getTime() + RETRY_LEASE_MS) : null },
    });

    if (claimed.count === 0 || !call.webhook.enabled) {
      continue;
    }

    const body = call.requestBody;
    const data = isJsonObject(body) ? body.payload : undefined;

    if (data === undefined) {
      io.logger.warn(`Webhook call ${call.id} has no stored payload, not retrying`);
      await prisma.webhookCall.update({ where: { id: call.id }, data: { nextAttemptAt: null } });
      continue;
    }

    await jobs.triggerJob({
      name: 'internal.execute-webhook',
      payload: {
        event: call.event,
        webhookId: call.webhookId,
        data,
        attempt: call.attempt + 1,
        retryOfCallId: call.id,
      },
    });
  }

  if (dueCalls.length > 0) {
    io.logger.info(`Retried ${dueCalls.length} webhook call(s)`);
  }
};
