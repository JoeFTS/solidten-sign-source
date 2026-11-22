import { executeScheduledSend } from '../../../server-only/scheduled-send/execute-scheduled-send';
import type { JobRunIO } from '../../client/_internal/job';
import type { TProcessScheduledSendJobDefinition } from './process-scheduled-send';

export const run = async ({ payload, io }: { payload: TProcessScheduledSendJobDefinition; io: JobRunIO }) => {
  // Cached so a retry of this job after a successful send does not run it again.
  const result = await io.runTask('execute-scheduled-send', async () => await executeScheduledSend(payload));

  io.logger.info(`Scheduled send ${payload.scheduledSendId}: ${result}`);
};
