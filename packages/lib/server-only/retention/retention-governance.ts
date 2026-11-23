import { prisma } from '@documenso/prisma';
import { OrganisationMemberRole, Prisma, TeamMemberRole } from '@prisma/client';

import { TEAM_DOCUMENT_VISIBILITY_MAP } from '../../constants/teams';
import { AppError, AppErrorCode } from '../../errors/app-error';
import type { RequestMetadata } from '../../universal/extract-request-metadata';
import { logger } from '../../utils/logger';
import { parseRetentionSettings, resolveRetentionSettings, type TRetentionSettings } from '../../utils/retention';
import { getHighestTeamRoleInGroup } from '../../utils/teams';

/**
 * Solid Ten Sign (S-M3): who may set a purge rule, and when a purge may run.
 *
 * - A purge rule needs at least RETENTION_PURGE_MIN_DAYS days, for every organisation.
 * - Setting or changing a purge rule needs team ADMIN or organisation ADMIN.
 * - No purge runs until RETENTION_PURGE_GRACE_DAYS after the last recorded change of a
 *   rule that applies to the team (its own or the organisation's).
 * - Every rule change is recorded (old, new, actor) and emailed to the admins.
 */

export const RETENTION_PURGE_MIN_DAYS = 30;
export const RETENTION_PURGE_GRACE_DAYS = 7;

export const RETENTION_SETTING_KEY = 'retentionSettings';

const DAY_MS = 24 * 60 * 60 * 1000;

export type RetentionScope = { type: 'organisation'; organisationId: string } | { type: 'team'; teamId: number };

const isPurgeRule = (rule: TRetentionSettings | null) => Boolean(rule?.enabled && rule.action === 'PURGE');

export const isSameRetentionRule = (a: TRetentionSettings | null, b: TRetentionSettings | null) =>
  JSON.stringify(a) === JSON.stringify(b);

const isOrganisationAdmin = async ({ organisationId, userId }: { organisationId: string; userId: number }) =>
  Boolean(
    await prisma.organisationMember.findFirst({
      where: {
        organisationId,
        userId,
        organisationGroupMembers: { some: { group: { organisationRole: OrganisationMemberRole.ADMIN } } },
      },
      select: { id: true },
    }),
  );

/**
 * The caller's highest role in a team, or null when they are not in it.
 */
export const getTeamRoleForUser = async ({ teamId, userId }: { teamId: number; userId: number }) => {
  const teamGroups = await prisma.teamGroup.findMany({
    where: {
      teamId,
      organisationGroup: { organisationGroupMembers: { some: { organisationMember: { userId } } } },
    },
  });

  return teamGroups.length > 0 ? getHighestTeamRoleInGroup(teamGroups) : null;
};

const getOrganisationIdForScope = async (scope: RetentionScope) => {
  if (scope.type === 'organisation') {
    return scope.organisationId;
  }

  const team = await prisma.team.findUniqueOrThrow({ where: { id: scope.teamId }, select: { organisationId: true } });

  return team.organisationId;
};

/**
 * Refuse a rule the caller may not set. The caller has already checked that they
 * manage the scope.
 */
export const assertRetentionRuleChangeAllowed = async ({
  scope,
  userId,
  previous,
  next,
}: {
  scope: RetentionScope;
  userId: number;
  previous: TRetentionSettings | null;
  next: TRetentionSettings | null;
}) => {
  if (isSameRetentionRule(previous, next)) {
    return;
  }

  // Solid Ten Sign (RT2-M1): judge the rule that will apply, not only the value saved. A team
  // going back to "inherit" can make the organisation's purge rule its own.
  const { before, after } = await getEffectiveRetentionRules({ scope, previous, next });

  if (!after || !isPurgeRule(after) || isSameRetentionRule(before, after)) {
    return;
  }

  if (after.days < RETENTION_PURGE_MIN_DAYS) {
    throw new AppError(AppErrorCode.INVALID_BODY, {
      message: `A rule that deletes documents permanently must keep them at least ${RETENTION_PURGE_MIN_DAYS} days.`,
    });
  }

  const organisationId = await getOrganisationIdForScope(scope);

  if (await isOrganisationAdmin({ organisationId, userId })) {
    return;
  }

  if (scope.type === 'team' && (await getTeamRoleForUser({ teamId: scope.teamId, userId })) === TeamMemberRole.ADMIN) {
    return;
  }

  throw new AppError(AppErrorCode.FORBIDDEN, {
    message: 'Only a team or organization admin can set a rule that deletes documents permanently.',
  });
};

/**
 * The rule that applies to the scope before and after a change. For a team, null means
 * "inherit the organisation's rule". For an organisation, the saved rule is the rule.
 */
export const getEffectiveRetentionRules = async ({
  scope,
  previous,
  next,
}: {
  scope: RetentionScope;
  previous: TRetentionSettings | null;
  next: TRetentionSettings | null;
}) => {
  if (scope.type === 'organisation') {
    return { before: previous?.enabled ? previous : null, after: next?.enabled ? next : null };
  }

  const team = await prisma.team.findUniqueOrThrow({
    where: { id: scope.teamId },
    select: { organisation: { select: { organisationGlobalSettings: { select: { retentionSettings: true } } } } },
  });

  const organisationValue = team.organisation.organisationGlobalSettings.retentionSettings;

  return {
    before: resolveRetentionSettings({ organisationValue, teamValue: previous }),
    after: resolveRetentionSettings({ organisationValue, teamValue: next }),
  };
};

const toJson = (rule: TRetentionSettings | null) => (rule === null ? Prisma.DbNull : rule);

type TRetentionRuleChange = {
  scope: RetentionScope;
  userId: number;
  previous: TRetentionSettings | null;
  next: TRetentionSettings | null;
  requestMetadata?: RequestMetadata;
};

/**
 * Write the audit row for a rule change. Solid Ten Sign (SETTINGS-AUDIT, retest): pass the
 * transaction that writes the new rule, so a saved rule always has its audit row (the purge
 * grace period counts from that row). Returns what the admin email needs, or null when the rule
 * did not change.
 */
export const writeRetentionRuleChangeAudit = async (
  tx: Prisma.TransactionClient,
  { scope, userId, previous, next, requestMetadata }: TRetentionRuleChange,
) => {
  if (isSameRetentionRule(previous, next)) {
    return null;
  }

  const organisationId = await getOrganisationIdForScope(scope);

  const user = await tx.user.findUniqueOrThrow({
    where: { id: userId },
    select: { id: true, email: true, name: true },
  });

  await tx.stSettingsAuditLog.create({
    data: {
      organisationId,
      teamId: scope.type === 'team' ? scope.teamId : null,
      setting: RETENTION_SETTING_KEY,
      oldValue: toJson(previous),
      newValue: toJson(next),
      userId: user.id,
      userEmail: user.email,
      userName: user.name,
      ipAddress: requestMetadata?.ipAddress ?? null,
      userAgent: requestMetadata?.userAgent ?? null,
    },
  });

  return { scope, organisationId, actor: user, next };
};

/** Tell the admins about a recorded change, after the commit. Best effort. */
export const emailRetentionRuleChange = async (
  change: NonNullable<Awaited<ReturnType<typeof writeRetentionRuleChangeAudit>>>,
) => {
  // Loaded on use: the sweep and the tests load this module and need no email code.
  const { emailAdminsAboutRuleChange } = await import('./retention-rule-change-email');

  await emailAdminsAboutRuleChange(change).catch((error) => {
    logger.error({ msg: '[RETENTION] Could not email admins about a rule change', error });
  });
};

export type RetentionPurgeBlock = 'BELOW_MINIMUM' | 'NO_RECORDED_CHANGE' | 'GRACE_PERIOD';

/**
 * Why a purge must not run for this team now, or null when it may.
 *
 * A rule with no recorded change (saved before changes were recorded) never purges until
 * it is saved again, so its grace period can start.
 */
export const getRetentionPurgeBlock = async ({
  teamId,
  settings,
  now,
}: {
  teamId: number;
  settings: TRetentionSettings;
  now: Date;
}): Promise<RetentionPurgeBlock | null> => {
  if (settings.days < RETENTION_PURGE_MIN_DAYS) {
    return 'BELOW_MINIMUM';
  }

  const team = await prisma.team.findUnique({ where: { id: teamId }, select: { organisationId: true } });

  if (!team) {
    return 'NO_RECORDED_CHANGE';
  }

  const lastChange = await prisma.stSettingsAuditLog.findFirst({
    where: {
      setting: RETENTION_SETTING_KEY,
      OR: [{ teamId }, { organisationId: team.organisationId, teamId: null }],
    },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });

  if (!lastChange) {
    return 'NO_RECORDED_CHANGE';
  }

  if (now.getTime() - lastChange.createdAt.getTime() < RETENTION_PURGE_GRACE_DAYS * DAY_MS) {
    return 'GRACE_PERIOD';
  }

  return null;
};

/**
 * The preview counts only documents the caller can see in each team.
 */
export const buildRetentionVisibilityWhere = async ({
  teamId,
  userId,
}: {
  teamId: number;
  userId: number;
}): Promise<Prisma.EnvelopeWhereInput | null> => {
  const role = await getTeamRoleForUser({ teamId, userId });

  if (!role) {
    return null;
  }

  return {
    teamId,
    OR: [{ visibility: { in: TEAM_DOCUMENT_VISIBILITY_MAP[role] } }, { userId }],
  };
};

export const readStoredRetentionRule = (value: unknown) => parseRetentionSettings(value);
