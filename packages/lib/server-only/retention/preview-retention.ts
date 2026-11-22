import { prisma } from '@documenso/prisma';
import { Prisma } from '@prisma/client';

import type { TRetentionSettings } from '../../utils/retention';
import { buildRetentionVisibilityWhere } from './retention-governance';
import { buildRetentionWhere } from './retention-rules';

/**
 * How many documents a rule would act on right now, for the settings page.
 *
 * For an organisation rule only teams that inherit it count; a team with its
 * own rule is not affected by the organisation's.
 */
export const countRetentionMatches = async ({
  scope,
  settings,
  userId,
  now = new Date(),
}: {
  scope: { type: 'organisation'; organisationId: string } | { type: 'team'; teamId: number };
  settings: TRetentionSettings;
  /** Solid Ten Sign (S-M3): only documents this user can see are counted. */
  userId: number;
  now?: Date;
}) => {
  if (!settings.enabled) {
    return 0;
  }

  const teamIds =
    scope.type === 'team'
      ? [scope.teamId]
      : (
          await prisma.team.findMany({
            where: {
              organisationId: scope.organisationId,
              // "Inherits" is stored as SQL NULL or as JSON null, depending on how the team was made.
              OR: [
                { teamGlobalSettings: { retentionSettings: { equals: Prisma.DbNull } } },
                { teamGlobalSettings: { retentionSettings: { equals: Prisma.JsonNull } } },
              ],
            },
            select: { id: true },
          })
        ).map((team) => team.id);

  if (teamIds.length === 0) {
    return 0;
  }

  const visibility = (
    await Promise.all(teamIds.map(async (teamId) => await buildRetentionVisibilityWhere({ teamId, userId })))
  ).filter((where) => where !== null);

  if (visibility.length === 0) {
    return 0;
  }

  return await prisma.envelope.count({
    where: { AND: [buildRetentionWhere({ teamIds, settings, now }), { OR: visibility }] },
  });
};
