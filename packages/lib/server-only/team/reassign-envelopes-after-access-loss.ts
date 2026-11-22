import { prisma } from '@documenso/prisma';
import type { Prisma } from '@prisma/client';

import { buildTeamWhereQuery } from '../../utils/teams';

type TTransaction = Prisma.TransactionClient;

/**
 * Solid Ten: after a group change, move the envelopes of users who lost their last path to a
 * team to the organisation owner, as delete-team-member and leave-organisation do.
 *
 * Group removal (organisation.group.update memberIds, organisation.group.delete, team.group.delete)
 * deleted only group rows, so Envelope.userId kept naming the removed member: the seal job then
 * failed "Team not found" on every try, and owner notices kept going to that member.
 *
 * Run it inside the transaction that removes the group rows, after the removal. Only envelopes
 * whose team the user can no longer reach through any group move; a user who still reaches the
 * team through another group keeps theirs. The organisation owner is never moved.
 */
export const reassignEnvelopesAfterAccessLoss = async (
  tx: TTransaction,
  { organisationId, userIds }: { organisationId: string; userIds: number[] },
) => {
  const organisation = await tx.organisation.findUniqueOrThrow({
    where: { id: organisationId },
    select: { ownerUserId: true },
  });

  for (const userId of new Set(userIds)) {
    if (userId === organisation.ownerUserId) {
      continue;
    }

    await tx.envelope.updateMany({
      where: {
        userId,
        team: {
          organisationId,
          // The same membership rule as buildTeamWhereQuery, negated.
          teamGroups: {
            none: { organisationGroup: { organisationGroupMembers: { some: { organisationMember: { userId } } } } },
          },
        },
      },
      data: { userId: organisation.ownerUserId },
    });
  }
};

/**
 * Solid Ten: whether the envelope owner can still reach the envelope's team. Owner-addressed
 * notices (signed, rejected, expired, comments) are skipped when not: a member who lost team
 * access gets no more content of that team's documents.
 */
export const canOwnerReachTeam = async ({ userId, teamId }: { userId: number; teamId: number }) =>
  (await prisma.team.count({ where: buildTeamWhereQuery({ teamId, userId }) })) > 0;

/** The user ids of the given organisation members. */
export const getUserIdsOfOrganisationMembers = async (tx: TTransaction, organisationMemberIds: string[]) =>
  (
    await tx.organisationMember.findMany({
      where: { id: { in: organisationMemberIds } },
      select: { userId: true },
    })
  ).map(({ userId }) => userId);
