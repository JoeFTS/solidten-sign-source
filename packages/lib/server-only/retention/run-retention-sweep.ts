import { prisma } from '@documenso/prisma';

import { logger } from '../../utils/logger';
import { buildRetentionWhere, findTeamRetentionRules, isRetentionDryRun } from './retention-rules';

const SWEEP_BATCH_SIZE = 500;

/**
 * Find envelopes the current retention rules apply to. Bounded per run; what
 * is left over is found again by the next run, since the test is "is it
 * still eligible", not "was it queued".
 */
export const findRetentionCandidates = async ({
  now = new Date(),
  teamIds,
  limit = SWEEP_BATCH_SIZE,
}: {
  now?: Date;
  /** At most this many candidates. */
  limit?: number;
  /**
   * Limit the sweep to these teams. The cron sweep passes nothing.
   */
  teamIds?: number[];
} = {}) => {
  const rules = await findTeamRetentionRules();

  const candidates: { envelopeId: string; teamId: number }[] = [];

  for (const rule of rules) {
    if (teamIds && !teamIds.includes(rule.teamId)) {
      continue;
    }

    const remaining = limit - candidates.length;

    if (remaining <= 0) {
      break;
    }

    const envelopes = await prisma.envelope.findMany({
      where: buildRetentionWhere({ teamIds: [rule.teamId], settings: rule.settings, now }),
      select: { id: true, teamId: true },
      orderBy: { completedAt: 'asc' },
      take: remaining,
    });

    candidates.push(...envelopes.map((envelope) => ({ envelopeId: envelope.id, teamId: envelope.teamId })));
  }

  if (isRetentionDryRun() && candidates.length > 0) {
    logger.info({ msg: `[RETENTION] Dry run: ${candidates.length} documents are due`, rules: rules.length });
  }

  return candidates;
};
