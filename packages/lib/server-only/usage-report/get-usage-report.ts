import { kyselyPrisma, prisma, sql } from '@documenso/prisma';
import { RecipientRole, SigningStatus } from '@prisma/client';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../types/document-audit-logs';
import { mapSecondaryIdToDocumentId } from '../../utils/envelope';
import { type ResolveTeamAnalyticsRangeOptions, resolveTeamAnalyticsRange } from '../../utils/team-analytics-range';
import {
  summarizeUsageByMember,
  summarizeUsageRows,
  type TUsageReportDocumentRow,
  type TUsageReportMember,
} from '../../utils/usage-report';
import { getOrganisationAnalyticsScope } from '../organisation/get-organisation-analytics-scope';
import {
  type ApplyEnvelopeScope,
  getTeamAnalyticsMembers,
  getTeamAnalyticsScope,
} from '../team/get-team-analytics-scope';

// Far above any small team's yearly volume; keeps one CSV request bounded.
export const USAGE_REPORT_MAX_DOCUMENTS = 50_000;

type TRangeOptions = Omit<ResolveTeamAnalyticsRangeOptions, 'now'>;

/**
 * The analytics scopes answer "not allowed" with UNAUTHORIZED (401). The caller is signed in,
 * so for these routes it is a 403. The rule itself is unchanged.
 */
const asForbidden = async <T>(promise: Promise<T>): Promise<T> => {
  try {
    return await promise;
  } catch (err) {
    if (err instanceof AppError && err.code === AppErrorCode.UNAUTHORIZED) {
      throw new AppError(AppErrorCode.FORBIDDEN, { message: err.message });
    }

    throw err;
  }
};

/**
 * Every document whose first DOCUMENT_SENT audit entry falls in [start, end), the same cohort the
 * existing "sent" numbers use. Soft-deleted documents are excluded by the scope.
 */
const getUsageReportRows = async ({
  applyEnvelopeScope,
  start,
  end,
}: {
  applyEnvelopeScope: ApplyEnvelopeScope;
  start: Date;
  end: Date;
}) => {
  const now = new Date();

  const rows = await kyselyPrisma.$kysely
    .with('scopedEnvelopes', (db) =>
      db
        .selectFrom('Envelope')
        .select([
          'Envelope.id',
          'Envelope.secondaryId',
          'Envelope.title',
          'Envelope.status',
          'Envelope.userId',
          'Envelope.teamId',
          'Envelope.completedAt',
        ])
        .where((eb) => applyEnvelopeScope(eb)),
    )
    .with('firstSent', (db) =>
      db
        .selectFrom('DocumentAuditLog')
        .innerJoin('scopedEnvelopes', 'scopedEnvelopes.id', 'DocumentAuditLog.envelopeId')
        .select(({ fn }) => ['DocumentAuditLog.envelopeId', fn.min('DocumentAuditLog.createdAt').as('sentAt')])
        .where('DocumentAuditLog.type', '=', DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_SENT)
        .where('DocumentAuditLog.createdAt', '>=', start)
        .where('DocumentAuditLog.createdAt', '<', end)
        .groupBy('DocumentAuditLog.envelopeId'),
    )
    .selectFrom('firstSent')
    .innerJoin('scopedEnvelopes', 'scopedEnvelopes.id', 'firstSent.envelopeId')
    .innerJoin('User', 'User.id', 'scopedEnvelopes.userId')
    .innerJoin('Team', 'Team.id', 'scopedEnvelopes.teamId')
    .select((eb) => [
      'scopedEnvelopes.id as envelopeId',
      'scopedEnvelopes.secondaryId',
      'scopedEnvelopes.title',
      'scopedEnvelopes.status',
      'scopedEnvelopes.userId as ownerUserId',
      'scopedEnvelopes.teamId',
      'scopedEnvelopes.completedAt',
      'firstSent.sentAt',
      'User.name as ownerName',
      'User.email as ownerEmail',
      'Team.name as teamName',
      eb
        .exists(
          eb
            .selectFrom('Recipient')
            .whereRef('Recipient.envelopeId', '=', 'scopedEnvelopes.id')
            .where('Recipient.expiresAt', 'is not', null)
            .where('Recipient.expiresAt', '<=', now)
            .where('Recipient.signingStatus', '=', sql.lit(SigningStatus.NOT_SIGNED))
            .where('Recipient.role', '!=', sql.lit(RecipientRole.CC))
            .select(sql.lit(1).as('one')),
        )
        .as('hasExpiredRecipient'),
      eb
        .selectFrom('Recipient')
        .whereRef('Recipient.envelopeId', '=', 'scopedEnvelopes.id')
        .select(({ fn }) => fn.countAll().as('count'))
        .as('recipientCount'),
    ])
    .orderBy('firstSent.sentAt', 'desc')
    .orderBy('scopedEnvelopes.id', 'asc')
    .limit(USAGE_REPORT_MAX_DOCUMENTS + 1)
    .execute();

  const isTruncated = rows.length > USAGE_REPORT_MAX_DOCUMENTS;

  const documents: TUsageReportDocumentRow[] = rows.slice(0, USAGE_REPORT_MAX_DOCUMENTS).map((row) => ({
    envelopeId: row.envelopeId,
    documentId: mapSecondaryIdToDocumentId(row.secondaryId),
    title: row.title,
    status: row.status,
    ownerUserId: row.ownerUserId,
    ownerName: row.ownerName,
    ownerEmail: row.ownerEmail,
    teamId: row.teamId,
    teamName: row.teamName,
    sentAt: new Date(row.sentAt),
    completedAt: row.completedAt ? new Date(row.completedAt) : null,
    isExpired: row.status === 'PENDING' && Boolean(row.hasExpiredRecipient),
    recipientCount: Number(row.recipientCount ?? 0),
  }));

  return { documents, isTruncated };
};

export type TTeamUsageReportOptions = TRangeOptions & {
  teamId: number;
  userId: number;
  userEmail: string;
};

const loadTeamReport = async ({ teamId, userId, userEmail, ...rangeOptions }: TTeamUsageReportOptions) => {
  const scope = await asForbidden(getTeamAnalyticsScope({ teamId, userId, userEmail }));
  const range = resolveTeamAnalyticsRange(rangeOptions);

  const { documents, isTruncated } = await getUsageReportRows({
    applyEnvelopeScope: scope.applyEnvelopeScope,
    start: range.start,
    end: range.end,
  });

  return { scope, range, documents, isTruncated };
};

export const getTeamUsageReport = async (options: TTeamUsageReportOptions) => {
  const { scope, range, documents, isTruncated } = await loadTeamReport(options);

  const members: TUsageReportMember[] = (await getTeamAnalyticsMembers(scope.teamId)).map((member) => ({
    userId: member.id,
    name: member.name,
    email: member.email,
  }));

  return {
    range,
    isTruncated,
    summary: summarizeUsageRows(documents),
    members: summarizeUsageByMember(members, documents),
  };
};

export const getTeamUsageReportDocuments = async (options: TTeamUsageReportOptions) => {
  const { range, documents, isTruncated } = await loadTeamReport(options);

  return { range, isTruncated, documents };
};

export type TOrganisationUsageReportOptions = TRangeOptions & {
  organisationId: string;
  userId: number;
};

const loadOrganisationReport = async ({ organisationId, userId, ...rangeOptions }: TOrganisationUsageReportOptions) => {
  const scope = await asForbidden(getOrganisationAnalyticsScope({ organisationId, userId }));
  const range = resolveTeamAnalyticsRange(rangeOptions);

  const { documents, isTruncated } = await getUsageReportRows({
    applyEnvelopeScope: scope.applyEnvelopeScope,
    start: range.start,
    end: range.end,
  });

  return { scope, range, documents, isTruncated };
};

export const getOrganisationUsageReport = async (options: TOrganisationUsageReportOptions) => {
  const { scope, range, documents, isTruncated } = await loadOrganisationReport(options);

  const organisationMembers = await prisma.organisationMember.findMany({
    where: { organisationId: scope.organisationId },
    select: { user: { select: { id: true, name: true, email: true } } },
  });

  const members: TUsageReportMember[] = organisationMembers.map(({ user }) => ({
    userId: user.id,
    name: user.name,
    email: user.email,
  }));

  return {
    range,
    isTruncated,
    summary: summarizeUsageRows(documents),
    members: summarizeUsageByMember(members, documents),
  };
};

export const getOrganisationUsageReportDocuments = async (options: TOrganisationUsageReportOptions) => {
  const { range, documents, isTruncated } = await loadOrganisationReport(options);

  return { range, isTruncated, documents };
};
