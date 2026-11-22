import { z } from 'zod';

import type { JobDefinition } from '../../client/_internal/job';

const PROCESS_SCHEDULED_SEND_JOB_DEFINITION_ID = 'internal.process-scheduled-send';

const PROCESS_SCHEDULED_SEND_JOB_DEFINITION_SCHEMA = z.object({
  scheduledSendId: z.string(),
  claimedAt: z.string(),
});

export type TProcessScheduledSendJobDefinition = z.infer<typeof PROCESS_SCHEDULED_SEND_JOB_DEFINITION_SCHEMA>;

export const PROCESS_SCHEDULED_SEND_JOB_DEFINITION = {
  id: PROCESS_SCHEDULED_SEND_JOB_DEFINITION_ID,
  name: 'Process Scheduled Send',
  version: '1.0.0',
  trigger: {
    name: PROCESS_SCHEDULED_SEND_JOB_DEFINITION_ID,
    schema: PROCESS_SCHEDULED_SEND_JOB_DEFINITION_SCHEMA,
  },
  handler: async ({ payload, io }) => {
    const handler = await import('./process-scheduled-send.handler');

    await handler.run({ payload, io });
  },
} as const satisfies JobDefinition<typeof PROCESS_SCHEDULED_SEND_JOB_DEFINITION_ID, TProcessScheduledSendJobDefinition>;
