import { prisma } from '@documenso/prisma';

import { ORGANISATION_MEMBER_ROLE_PERMISSIONS_MAP } from '../../constants/organisations';
import { TEAM_MEMBER_ROLE_PERMISSIONS_MAP } from '../../constants/teams';
import { AppError, AppErrorCode } from '../../errors/app-error';
import { buildOrganisationWhereQuery } from '../../utils/organisations';
import { sanitizeSmsText } from '../../utils/sms/text';
import { buildTeamWhereQuery } from '../../utils/teams';
import { isSmsProviderConfigured } from './sms-config';

const assertProvider = () => {
  if (!isSmsProviderConfigured()) {
    throw new AppError(AppErrorCode.NOT_SETUP, { message: 'Text messages are not set up on this server.' });
  }
};

/**
 * Solid Ten Sign (S-M4): the sender label is the name every text starts with, so it
 * can be used to pose as a bank or a brand. Only organisation admins may change it.
 */
const assertMaySetSenderLabel = async ({
  userId,
  organisationId,
  current,
  next,
}: {
  userId: number;
  organisationId: string;
  current: string | null;
  next: string | null | undefined;
}) => {
  if (next === undefined || next === current) {
    return;
  }

  const admin = await prisma.organisation.findFirst({
    where: buildOrganisationWhereQuery({
      organisationId,
      userId,
      roles: ORGANISATION_MEMBER_ROLE_PERMISSIONS_MAP.DELETE_ORGANISATION,
    }),
    select: { id: true },
  });

  if (!admin) {
    throw new AppError(AppErrorCode.FORBIDDEN, {
      message: 'Only an organization admin can change the text message sender name.',
    });
  }
};

const cleanLabel = (label: string | null | undefined) => {
  if (label === undefined) {
    return undefined;
  }

  const cleaned = label === null ? '' : sanitizeSmsText(label).slice(0, 40);

  return cleaned === '' ? null : cleaned;
};

export const getOrganisationSmsSettings = async ({
  userId,
  organisationId,
}: {
  userId: number;
  organisationId: string;
}) => {
  const organisation = await prisma.organisation.findFirst({
    where: buildOrganisationWhereQuery({
      organisationId,
      userId,
      roles: ORGANISATION_MEMBER_ROLE_PERMISSIONS_MAP.MANAGE_ORGANISATION,
    }),
    select: { smsSettings: { select: { enabled: true, senderLabel: true } } },
  });

  if (!organisation) {
    throw new AppError(AppErrorCode.FORBIDDEN, { message: 'You cannot manage this organization.' });
  }

  return {
    isProviderConfigured: isSmsProviderConfigured(),
    enabled: organisation.smsSettings?.enabled ?? false,
    senderLabel: organisation.smsSettings?.senderLabel ?? null,
  };
};

export const updateOrganisationSmsSettings = async ({
  userId,
  organisationId,
  enabled,
  senderLabel,
}: {
  userId: number;
  organisationId: string;
  enabled?: boolean;
  senderLabel?: string | null;
}) => {
  assertProvider();

  const organisation = await prisma.organisation.findFirst({
    where: buildOrganisationWhereQuery({
      organisationId,
      userId,
      roles: ORGANISATION_MEMBER_ROLE_PERMISSIONS_MAP.MANAGE_ORGANISATION,
    }),
    select: { id: true, smsSettings: { select: { senderLabel: true } } },
  });

  if (!organisation) {
    throw new AppError(AppErrorCode.FORBIDDEN, { message: 'You cannot manage this organization.' });
  }

  const label = cleanLabel(senderLabel);

  await assertMaySetSenderLabel({
    userId,
    organisationId: organisation.id,
    current: organisation.smsSettings?.senderLabel ?? null,
    next: label,
  });

  await prisma.organisationSmsSettings.upsert({
    where: { organisationId: organisation.id },
    create: { organisationId: organisation.id, enabled: enabled ?? false, senderLabel: label ?? null },
    update: { enabled, senderLabel: label },
  });
};

export const updateTeamSmsSettings = async ({
  userId,
  teamId,
  enabled,
  senderLabel,
}: {
  userId: number;
  teamId: number;
  /** Null inherits from the organisation. */
  enabled?: boolean | null;
  senderLabel?: string | null;
}) => {
  assertProvider();

  const team = await prisma.team.findFirst({
    where: buildTeamWhereQuery({
      teamId,
      userId,
      roles: TEAM_MEMBER_ROLE_PERMISSIONS_MAP.MANAGE_TEAM,
    }),
    select: {
      id: true,
      organisationId: true,
      smsSettings: { select: { senderLabel: true } },
      organisation: { select: { smsSettings: { select: { enabled: true } } } },
    },
  });

  if (!team) {
    throw new AppError(AppErrorCode.FORBIDDEN, { message: 'You cannot manage this team.' });
  }

  // Solid Ten Sign (S-M4): a team can turn texts off for itself, not on over the organisation.
  if (enabled === true && !team.organisation.smsSettings?.enabled) {
    throw new AppError(AppErrorCode.FORBIDDEN, {
      message: 'Text messages are off for your organization. Ask an organization admin to turn them on.',
    });
  }

  const label = cleanLabel(senderLabel);

  await assertMaySetSenderLabel({
    userId,
    organisationId: team.organisationId,
    current: team.smsSettings?.senderLabel ?? null,
    next: label,
  });

  await prisma.teamSmsSettings.upsert({
    where: { teamId: team.id },
    create: { teamId: team.id, enabled: enabled ?? null, senderLabel: label ?? null },
    update: { enabled, senderLabel: label },
  });
};
