import { applyRetentionToEnvelope, deleteRetentionObjects } from '../../../server-only/retention/apply-retention';
import type { JobRunIO } from '../../client/_internal/job';
import type { TProcessRetentionJobDefinition } from './process-retention';

export const run = async ({ payload, io }: { payload: TProcessRetentionJobDefinition; io: JobRunIO }) => {
  // Cached, so a retry after the rows are gone still deletes the stored files.
  const outcome = await io.runTask('apply-retention', async () => await applyRetentionToEnvelope(payload));

  io.logger.info(`Retention for ${payload.envelopeId}: ${outcome.result}`);

  if (outcome.result !== 'PURGED' || outcome.objectKeysToDelete.length === 0) {
    return;
  }

  await io.runTask('delete-stored-objects', async () => {
    const failedKeys = await deleteRetentionObjects(outcome.objectKeysToDelete);

    if (failedKeys.length > 0) {
      throw new Error(`Could not delete ${failedKeys.length} stored objects for ${payload.envelopeId}`);
    }
  });
};
