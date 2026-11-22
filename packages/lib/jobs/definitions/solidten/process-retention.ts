import { z } from 'zod';

import type { JobDefinition } from '../../client/_internal/job';

const PROCESS_RETENTION_JOB_DEFINITION_ID = 'internal.process-retention';

const PROCESS_RETENTION_JOB_DEFINITION_SCHEMA = z.object({
  envelopeId: z.string(),
});

export type TProcessRetentionJobDefinition = z.infer<typeof PROCESS_RETENTION_JOB_DEFINITION_SCHEMA>;

export const PROCESS_RETENTION_JOB_DEFINITION = {
  id: PROCESS_RETENTION_JOB_DEFINITION_ID,
  name: 'Process Retention',
  version: '1.0.0',
  trigger: {
    name: PROCESS_RETENTION_JOB_DEFINITION_ID,
    schema: PROCESS_RETENTION_JOB_DEFINITION_SCHEMA,
  },
  handler: async ({ payload, io }) => {
    const handler = await import('./process-retention.handler');

    await handler.run({ payload, io });
  },
} as const satisfies JobDefinition<typeof PROCESS_RETENTION_JOB_DEFINITION_ID, TProcessRetentionJobDefinition>;
