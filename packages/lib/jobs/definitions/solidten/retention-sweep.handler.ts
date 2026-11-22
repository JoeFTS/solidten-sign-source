import { processRetentionBatch } from '../../../server-only/retention/process-retention-batch';
import { jobs } from '../../client';
import type { JobRunIO } from '../../client/_internal/job';
import type { TRetentionSweepJobDefinition } from './retention-sweep';

export const run = async ({ io }: { payload: TRetentionSweepJobDefinition; io: JobRunIO }) => {
  // Envelopes are handled here one at a time rather than fanned out to parallel
  // jobs: a purge reads and deletes a document's files, and hundreds at once ran
  // the app out of memory.
  const result = await processRetentionBatch({
    runStep: async (key, step) => await io.runTask(key, step),
  });

  io.logger.info(`Retention: ${result.candidateCount} due, ${result.actedCount} done, ${result.failedCount} failed`);

  if (result.shouldContinue) {
    await jobs.triggerJob({ name: 'internal.retention-sweep', payload: {} });
  }
};
