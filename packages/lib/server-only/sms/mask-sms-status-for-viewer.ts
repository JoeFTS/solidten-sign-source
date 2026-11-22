import { prisma } from '@documenso/prisma';
import { TeamMemberRole } from '@prisma/client';

import { maskPhoneNumber } from '../../utils/sms/phone';
import { getHighestTeamRoleInGroup } from '../../utils/teams';

/**
 * Solid Ten Sign: full mobile numbers only for the envelope's owner and team ADMIN or
 * MANAGER. Other team members see the last four digits, like the audit log.
 */
export const canSeeFullPhoneNumbers = async ({ envelopeId, userId }: { envelopeId: string; userId: number }) => {
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

  if (teamGroups.length === 0) {
    return false;
  }

  const role = getHighestTeamRoleInGroup(teamGroups);

  return role === TeamMemberRole.ADMIN || role === TeamMemberRole.MANAGER;
};

export const maskSmsStatusPhones = <T extends { recipients: { phoneE164: string | null }[] }>(status: T): T => ({
  ...status,
  recipients: status.recipients.map((recipient) => ({
    ...recipient,
    phoneE164: recipient.phoneE164 ? maskPhoneNumber(recipient.phoneE164) : null,
  })),
});
