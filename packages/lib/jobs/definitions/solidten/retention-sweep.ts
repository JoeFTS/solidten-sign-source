import { z } from 'zod';

import type { JobDefinition } from '../../client/_internal/job';

const RETENTION_SWEEP_JOB_DEFINITION_ID = 'internal.retention-sweep';

const RETENTION_SWEEP_JOB_DEFINITION_SCHEMA = z.object({});

export type TRetentionSweepJobDefinition = z.infer<typeof RETENTION_SWEEP_JOB_DEFINITION_SCHEMA>;

export const RETENTION_SWEEP_JOB_DEFINITION = {
  id: RETENTION_SWEEP_JOB_DEFINITION_ID,
  name: 'Retention Sweep',
  version: '1.0.0',
  trigger: {
    name: RETENTION_SWEEP_JOB_DEFINITION_ID,
    schema: RETENTION_SWEEP_JOB_DEFINITION_SCHEMA,
    // Daily. A missed day is caught up the next day: eligibility does not expire.
    cron: '30 3 * * *',
  },
  handler: async ({ payload, io }) => {
    const handler = await import('./retention-sweep.handler');

    await handler.run({ payload, io });
  },
} as const satisfies JobDefinition<typeof RETENTION_SWEEP_JOB_DEFINITION_ID, TRetentionSweepJobDefinition>;
