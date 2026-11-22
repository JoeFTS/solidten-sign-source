import { prisma } from '@documenso/prisma';
import { Prisma } from '@prisma/client';

import { ORGANISATION_MEMBER_ROLE_PERMISSIONS_MAP } from '../../constants/organisations';
import { TEAM_MEMBER_ROLE_PERMISSIONS_MAP } from '../../constants/teams';
import { AppError, AppErrorCode } from '../../errors/app-error';
import type { RequestMetadata } from '../../universal/extract-request-metadata';
import { buildOrganisationWhereQuery } from '../../utils/organisations';
import { parseRetentionSettings, type TRetentionSettings } from '../../utils/retention';
import { buildTeamWhereQuery } from '../../utils/teams';
import {
  assertRetentionRuleChangeAllowed,
  emailRetentionRuleChange,
  readStoredRetentionRule,
  writeRetentionRuleChangeAudit,
} from '../retention/retention-governance';

export type LifecycleSettingsScope =
  | { type: 'organisation'; organisationId: string }
  | { type: 'team'; teamId: number };

const LIFECYCLE_SETTINGS_SELECT = {
  allowSenderReassign: true,
  allowSignerReassign: true,
  allowInPersonSigning: true,
  commentsEnabled: true,
  commentsSharedThread: true,
  retentionSettings: true,
} satisfies Prisma.OrganisationGlobalSettingsSelect;

/**
 * The settings row a manager may change for the scope. Team settings are only
 * reachable by team managers, organisation settings by organisation managers.
 */
export const findSettingsIdForManager = async ({
  scope,
  userId,
}: {
  scope: LifecycleSettingsScope;
  userId: number;
}) => {
  if (scope.type === 'organisation') {
    const organisation = await prisma.organisation.findFirst({
      where: buildOrganisationWhereQuery({
        organisationId: scope.organisationId,
        userId,
        roles: ORGANISATION_MEMBER_ROLE_PERMISSIONS_MAP.MANAGE_ORGANISATION,
      }),
      select: { organisationGlobalSettingsId: true },
    });

    if (!organisation) {
      throw new AppError(AppErrorCode.FORBIDDEN, {
        message: 'You do not have permission to manage this organisation.',
      });
    }

    return { organisationSettingsId: organisation.organisationGlobalSettingsId, teamSettingsId: null };
  }

  const team = await prisma.team.findFirst({
    where: buildTeamWhereQuery({
      teamId: scope.teamId,
      userId,
      roles: TEAM_MEMBER_ROLE_PERMISSIONS_MAP.MANAGE_TEAM,
    }),
    select: {
      teamGlobalSettingsId: true,
      organisation: { select: { organisationGlobalSettingsId: true } },
    },
  });

  if (!team) {
    throw new AppError(AppErrorCode.FORBIDDEN, {
      message: 'You do not have permission to manage this team.',
    });
  }

  return {
    organisationSettingsId: team.organisation.organisationGlobalSettingsId,
    teamSettingsId: team.teamGlobalSettingsId,
  };
};

export const getLifecycleSettings = async ({ scope, userId }: { scope: LifecycleSettingsScope; userId: number }) => {
  const { organisationSettingsId, teamSettingsId } = await findSettingsIdForManager({ scope, userId });

  const organisation = await prisma.organisationGlobalSettings.findUniqueOrThrow({
    where: { id: organisationSettingsId },
    select: LIFECYCLE_SETTINGS_SELECT,
  });

  const team = teamSettingsId
    ? await prisma.teamGlobalSettings.findUniqueOrThrow({
        where: { id: teamSettingsId },
        select: LIFECYCLE_SETTINGS_SELECT,
      })
    : null;

  return {
    organisation: { ...organisation, retentionSettings: parseRetentionSettings(organisation.retentionSettings) },
    team: team ? { ...team, retentionSettings: parseRetentionSettings(team.retentionSettings) } : null,
  };
};

export type LifecycleSettingsUpdate = {
  allowSenderReassign?: boolean | null;
  allowSignerReassign?: boolean | null;
  allowInPersonSigning?: boolean | null;
  commentsEnabled?: boolean | null;
  commentsSharedThread?: boolean | null;
  /**
   * Null on a team means "inherit"; null on the organisation means "off".
   */
  retentionSettings?: TRetentionSettings | null;
};

const toJsonValue = (value: TRetentionSettings | null | undefined) => {
  if (value === undefined) {
    return undefined;
  }

  return value === null ? Prisma.DbNull : value;
};

export const updateLifecycleSettings = async ({
  scope,
  userId,
  data,
  requestMetadata,
}: {
  scope: LifecycleSettingsScope;
  userId: number;
  data: LifecycleSettingsUpdate;
  requestMetadata?: RequestMetadata;
}) => {
  const { organisationSettingsId, teamSettingsId } = await findSettingsIdForManager({ scope, userId });

  // Solid Ten Sign (SETTINGS-AUDIT, retest): the settings row is locked, the previous rule read,
  // the new settings written and the rule change recorded in one transaction. Before, the audit
  // row was written after the commit: a failure in between left a new rule with no recorded
  // change, so the purge grace period counted from an older change. Two saves at once could
  // also record the wrong previous rule.
  const recorded = await prisma.$transaction(async (tx) => {
    if (teamSettingsId) {
      await tx.$queryRaw`SELECT 1 FROM "TeamGlobalSettings" WHERE "id" = ${teamSettingsId} FOR UPDATE`;
    } else {
      await tx.$queryRaw`SELECT 1 FROM "OrganisationGlobalSettings" WHERE "id" = ${organisationSettingsId} FOR UPDATE`;
    }

    // Solid Ten Sign (S-M3): who may set a purge rule, and evidence of every rule change.
    const retentionChange =
      data.retentionSettings === undefined
        ? null
        : {
            previous: readStoredRetentionRule(
              teamSettingsId
                ? (
                    await tx.teamGlobalSettings.findUniqueOrThrow({
                      where: { id: teamSettingsId },
                      select: { retentionSettings: true },
                    })
                  ).retentionSettings
                : (
                    await tx.organisationGlobalSettings.findUniqueOrThrow({
                      where: { id: organisationSettingsId },
                      select: { retentionSettings: true },
                    })
                  ).retentionSettings,
            ),
            next: data.retentionSettings,
          };

    if (retentionChange) {
      await assertRetentionRuleChangeAllowed({ scope, userId, ...retentionChange });
    }

    await writeLifecycleSettings(tx, { organisationSettingsId, teamSettingsId, data });

    return retentionChange
      ? await writeRetentionRuleChangeAudit(tx, { scope, userId, requestMetadata, ...retentionChange })
      : null;
  });

  if (recorded) {
    await emailRetentionRuleChange(recorded);
  }
};

const writeLifecycleSettings = async (
  tx: Prisma.TransactionClient,
  {
    organisationSettingsId,
    teamSettingsId,
    data,
  }: {
    organisationSettingsId: string;
    teamSettingsId: string | null;
    data: LifecycleSettingsUpdate;
  },
) => {
  if (teamSettingsId) {
    await tx.teamGlobalSettings.update({
      where: { id: teamSettingsId },
      data: { ...data, retentionSettings: toJsonValue(data.retentionSettings) },
    });

    return;
  }

  // Organisation values cannot be null: there is nothing above them to inherit from.
  await tx.organisationGlobalSettings.update({
    where: { id: organisationSettingsId },
    data: {
      allowSenderReassign: data.allowSenderReassign ?? undefined,
      allowSignerReassign: data.allowSignerReassign ?? undefined,
      allowInPersonSigning: data.allowInPersonSigning ?? undefined,
      commentsEnabled: data.commentsEnabled ?? undefined,
      commentsSharedThread: data.commentsSharedThread ?? undefined,
      retentionSettings: toJsonValue(data.retentionSettings),
    },
  });
};
