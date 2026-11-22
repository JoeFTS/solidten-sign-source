import { z } from 'zod';

import type { JobDefinition } from '../../client/_internal/job';

const RETRY_WEBHOOK_CALLS_SWEEP_JOB_DEFINITION_ID = 'internal.retry-webhook-calls-sweep';

const RETRY_WEBHOOK_CALLS_SWEEP_JOB_DEFINITION_SCHEMA = z.object({});

export type TRetryWebhookCallsSweepJobDefinition = z.infer<typeof RETRY_WEBHOOK_CALLS_SWEEP_JOB_DEFINITION_SCHEMA>;

export const RETRY_WEBHOOK_CALLS_SWEEP_JOB_DEFINITION = {
  id: RETRY_WEBHOOK_CALLS_SWEEP_JOB_DEFINITION_ID,
  name: 'Retry Webhook Calls Sweep',
  version: '1.0.0',
  trigger: {
    name: RETRY_WEBHOOK_CALLS_SWEEP_JOB_DEFINITION_ID,
    schema: RETRY_WEBHOOK_CALLS_SWEEP_JOB_DEFINITION_SCHEMA,
    cron: '* * * * *', // Every minute.
  },
  handler: async ({ payload, io }) => {
    const handler = await import('./retry-webhook-calls-sweep.handler');

    await handler.run({ payload, io });
  },
} as const satisfies JobDefinition<
  typeof RETRY_WEBHOOK_CALLS_SWEEP_JOB_DEFINITION_ID,
  TRetryWebhookCallsSweepJobDefinition
>;
