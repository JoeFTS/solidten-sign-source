import type { JobRunIO } from '../../jobs/client/_internal/job';
import { logger } from '../../utils/logger';
import { applyRetentionToEnvelope, deleteRetentionObjects, type RetentionOutcome } from './apply-retention';
import { isRetentionDryRun } from './retention-rules';
import { findRetentionCandidates } from './run-retention-sweep';

/**
 * Envelopes one sweep run handles. Each is purged on its own, one after the
 * other, so memory stays flat however large the backlog is; the sweep queues
 * another run when this one was full.
 */
export const RETENTION_RUN_LIMIT = 50;

type RunStep = JobRunIO['runTask'];

const runDirectly: RunStep = async (_key, step) => await step();

/**
 * One bounded pass of the retention sweep.
 *
 * `runStep` lets the job runner record each envelope's result, so a re-run of the
 * same job skips envelopes it already handled and still deletes their stored
 * files. Every step is also safe to repeat on its own: an envelope that is already
 * gone, or no longer due, comes back SKIPPED.
 */
export const processRetentionBatch = async ({
  now = new Date(),
  teamIds,
  limit = RETENTION_RUN_LIMIT,
  runStep = runDirectly,
}: {
  now?: Date;
  teamIds?: number[];
  limit?: number;
  runStep?: RunStep;
} = {}) => {
  const candidates = await findRetentionCandidates({ now, teamIds, limit });

  let actedCount = 0;
  let failedCount = 0;

  for (const { envelopeId } of candidates) {
    try {
      const outcome = await runStep<RetentionOutcome>(
        `retention:${envelopeId}`,
        async () => await applyRetentionToEnvelope({ envelopeId, now }),
      );

      if (outcome.result === 'PURGED' || outcome.result === 'SOFT_DELETED') {
        actedCount += 1;
      }

      if (outcome.result === 'PURGED' && outcome.objectKeysToDelete.length > 0) {
        await runStep(`retention-objects:${envelopeId}`, async () => {
          const failedKeys = await deleteRetentionObjects(outcome.objectKeysToDelete);

          if (failedKeys.length > 0) {
            logger.error({ msg: '[RETENTION] Stored objects left behind', envelopeId, failedKeys });
          }
        });
      }
    } catch (err) {
      // One bad envelope must not stop the rest; it stays due and is tried next run.
      failedCount += 1;
      logger.error({ msg: '[RETENTION] Could not apply retention', envelopeId, err });
    }
  }

  // Queue the next run only when this one was full and changed something, so a
  // dry run, or an envelope that keeps failing, cannot loop.
  const shouldContinue = candidates.length === limit && actedCount > 0 && !isRetentionDryRun();

  return { candidateCount: candidates.length, actedCount, failedCount, shouldContinue };
};
