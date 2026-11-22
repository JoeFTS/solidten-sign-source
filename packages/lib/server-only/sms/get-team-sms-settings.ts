import { prisma } from '@documenso/prisma';

import { isSmsProviderConfigured } from './sms-config';

export type TEffectiveSmsSettings = {
  isProviderConfigured: boolean;
  /** Provider configured AND the team (or its organisation) turned texts on. */
  isEnabled: boolean;
  senderLabel: string;
  organisation: { enabled: boolean; senderLabel: string | null };
  team: { enabled: boolean | null; senderLabel: string | null };
};

export const SMS_DEFAULT_SENDER_LABEL = 'Solid Ten Sign';

/**
 * Solid Ten Sign (SEC2-M3): the name a text message starts with. Only organisation admins set a
 * label. Without one, the organisation's name, else a fixed name. Never the team name: a team
 * manager can rename the team ("Chase Bank Fraud Dept").
 */
export const resolveSmsSenderLabel = ({
  teamLabel,
  organisationLabel,
  organisationName,
}: {
  teamLabel: string | null;
  organisationLabel: string | null;
  organisationName: string | null | undefined;
}) => teamLabel?.trim() || organisationLabel?.trim() || organisationName?.trim() || SMS_DEFAULT_SENDER_LABEL;

/**
 * A team can turn texts off for itself, never on when its organisation has them off
 * (S-M4). A team label overrides the organisation's; only organisation admins can
 * set a label at either level.
 */
export const getTeamSmsSettings = async ({ teamId }: { teamId: number }): Promise<TEffectiveSmsSettings> => {
  const team = await prisma.team.findUniqueOrThrow({
    where: { id: teamId },
    select: {
      smsSettings: { select: { enabled: true, senderLabel: true } },
      organisation: {
        select: {
          name: true,
          smsSettings: { select: { enabled: true, senderLabel: true } },
        },
      },
    },
  });

  const organisation = {
    enabled: team.organisation.smsSettings?.enabled ?? false,
    senderLabel: team.organisation.smsSettings?.senderLabel ?? null,
  };

  const teamSettings = {
    enabled: team.smsSettings?.enabled ?? null,
    senderLabel: team.smsSettings?.senderLabel ?? null,
  };

  const isProviderConfigured = isSmsProviderConfigured();

  return {
    isProviderConfigured,
    isEnabled: isProviderConfigured && organisation.enabled && teamSettings.enabled !== false,
    senderLabel: resolveSmsSenderLabel({
      teamLabel: teamSettings.senderLabel,
      organisationLabel: organisation.senderLabel,
      organisationName: team.organisation.name,
    }),
    organisation,
    team: teamSettings,
  };
};
