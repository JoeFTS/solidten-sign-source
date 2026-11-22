import { claimDueScheduledSends } from '../../../server-only/scheduled-send/claim-due-scheduled-sends';
import { jobs } from '../../client';
import type { JobRunIO } from '../../client/_internal/job';
import type { TScheduledSendSweepJobDefinition } from './scheduled-send-sweep';

export const run = async ({ io }: { payload: TScheduledSendSweepJobDefinition; io: JobRunIO }) => {
  const claims = await claimDueScheduledSends();

  if (claims.length === 0) {
    return;
  }

  io.logger.info(`Claimed ${claims.length} scheduled sends`);

  // A claim whose job never starts is found again by the stale-claim recovery.
  await Promise.allSettled(
    claims.map(async (claim) => {
      await jobs.triggerJob({
        name: 'internal.process-scheduled-send',
        payload: claim,
      });
    }),
  );
};
