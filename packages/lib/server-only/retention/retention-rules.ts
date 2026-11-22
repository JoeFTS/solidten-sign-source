import { prisma } from '@documenso/prisma';
import { EnvelopeType, Prisma } from '@prisma/client';

import {
  getRetentionCutoff,
  getRetentionStatuses,
  resolveRetentionSettings,
  type TRetentionSettings,
} from '../../utils/retention';

/**
 * When set, the retention sweep logs what it would do and changes nothing.
 */
export const isRetentionDryRun = () => process.env.NEXT_PRIVATE_RETENTION_DRY_RUN === 'true';

export type TeamRetentionRule = {
  teamId: number;
  settings: TRetentionSettings;
};

/**
 * Every team whose effective retention rule is on.
 */
export const findTeamRetentionRules = async (): Promise<TeamRetentionRule[]> => {
  const teams = await prisma.team.findMany({
    where: {
      OR: [
        { teamGlobalSettings: { retentionSettings: { not: Prisma.DbNull } } },
        { organisation: { organisationGlobalSettings: { retentionSettings: { not: Prisma.DbNull } } } },
      ],
    },
    select: {
      id: true,
      teamGlobalSettings: { select: { retentionSettings: true } },
      organisation: { select: { organisationGlobalSettings: { select: { retentionSettings: true } } } },
    },
  });

  return teams.flatMap((team) => {
    const settings = resolveRetentionSettings({
      organisationValue: team.organisation.organisationGlobalSettings.retentionSettings,
      teamValue: team.teamGlobalSettings.retentionSettings,
    });

    return settings ? [{ teamId: team.id, settings }] : [];
  });
};

export const getTeamRetentionSettings = async (teamId: number) => {
  const team = await prisma.team.findUnique({
    where: { id: teamId },
    select: {
      teamGlobalSettings: { select: { retentionSettings: true } },
      organisation: { select: { organisationGlobalSettings: { select: { retentionSettings: true } } } },
    },
  });

  if (!team) {
    return null;
  }

  return resolveRetentionSettings({
    organisationValue: team.organisation.organisationGlobalSettings.retentionSettings,
    teamValue: team.teamGlobalSettings.retentionSettings,
  });
};

/**
 * The database filter for envelopes a rule applies to. It must stay in step
 * with `isEnvelopeRetentionEligible`, which re-checks each envelope before acting.
 */
export const buildRetentionWhere = ({
  teamIds,
  settings,
  now,
}: {
  teamIds: number[];
  settings: TRetentionSettings;
  now: Date;
}): Prisma.EnvelopeWhereInput => ({
  teamId: { in: teamIds },
  type: EnvelopeType.DOCUMENT,
  status: { in: getRetentionStatuses(settings) },
  completedAt: { not: null, lte: getRetentionCutoff(settings, now) },
  ...(settings.action === 'SOFT_DELETE' ? { deletedAt: null } : {}),
});
