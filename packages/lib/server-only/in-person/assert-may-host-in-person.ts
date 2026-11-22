import { prisma } from '@documenso/prisma';
import { TeamMemberRole } from '@prisma/client';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { getHighestTeamRoleInGroup } from '../../utils/teams';

/**
 * Solid Ten Sign (S-L1): who may host in-person signing.
 *
 * Decision: the document's owner, or a team ADMIN or MANAGER. A plain member who can see a
 * document cannot hand it out on their device: the host chooses who must enter an email
 * code, and their device becomes the signing place in the evidence.
 */
export const IN_PERSON_HOST_ROLES: TeamMemberRole[] = [TeamMemberRole.ADMIN, TeamMemberRole.MANAGER];

export const IN_PERSON_NOT_HOST_MESSAGE =
  'Only the document owner or a team admin or manager can host in-person signing.';

export const canHostInPerson = async ({ envelopeId, userId }: { envelopeId: string; userId: number }) => {
  const envelope = await prisma.envelope.findUnique({
    where: { id: envelopeId },
    select: { userId: true, teamId: true },
  });

  if (!envelope) {
    return false;
  }

  if (envelope.userId === userId) {
    return true;
  }

  const teamGroups = await prisma.teamGroup.findMany({
    where: {
      teamId: envelope.teamId,
      organisationGroup: { organisationGroupMembers: { some: { organisationMember: { userId } } } },
    },
  });

  return teamGroups.length > 0 && IN_PERSON_HOST_ROLES.includes(getHighestTeamRoleInGroup(teamGroups));
};

export const assertMayHostInPerson = async (options: { envelopeId: string; userId: number }) => {
  if (!(await canHostInPerson(options))) {
    throw new AppError(AppErrorCode.FORBIDDEN, { message: IN_PERSON_NOT_HOST_MESSAGE });
  }
};
