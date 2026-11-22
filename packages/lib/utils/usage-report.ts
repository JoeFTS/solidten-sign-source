import type { DocumentStatus } from '@prisma/client';

import { toCsv } from './csv';

export type TUsageReportDocumentRow = {
  envelopeId: string;
  documentId: number;
  title: string;
  status: DocumentStatus;
  ownerUserId: number;
  ownerName: string | null;
  ownerEmail: string;
  teamId: number;
  teamName: string;
  sentAt: Date;
  completedAt: Date | null;
  /** PENDING with at least one non-CC recipient whose signing window has passed. */
  isExpired: boolean;
  recipientCount: number;
};

export type TUsageReportCounts = {
  sent: number;
  completed: number;
  declined: number;
  cancelled: number;
  expired: number;
  /** Still waiting and not expired. */
  pending: number;
};

export type TDurationStats = {
  count: number;
  averageMs: number | null;
  medianMs: number | null;
};

export type TUsageReportSummary = TUsageReportCounts & {
  completionRate: number | null;
  timeToComplete: TDurationStats;
};

export const computeDurationStats = (durationsMs: number[]): TDurationStats => {
  const values = durationsMs.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);

  if (values.length === 0) {
    return { count: 0, averageMs: null, medianMs: null };
  }

  const sum = values.reduce((total, value) => total + value, 0);
  const middle = Math.floor(values.length / 2);

  const medianMs = values.length % 2 === 1 ? values[middle] : (values[middle - 1] + values[middle]) / 2;

  return {
    count: values.length,
    averageMs: Math.round(sum / values.length),
    medianMs: Math.round(medianMs),
  };
};

/**
 * Milliseconds from first send to completion, or null when not completed. A completion stamped
 * before the send (clock skew, imported data) is not a real duration and is left out.
 */
export const getTimeToCompleteMs = (row: Pick<TUsageReportDocumentRow, 'status' | 'sentAt' | 'completedAt'>) => {
  if (row.status !== 'COMPLETED' || !row.completedAt) {
    return null;
  }

  const duration = row.completedAt.getTime() - row.sentAt.getTime();

  return duration >= 0 ? duration : null;
};

export const summarizeUsageRows = (rows: TUsageReportDocumentRow[]): TUsageReportSummary => {
  const counts: TUsageReportCounts = { sent: 0, completed: 0, declined: 0, cancelled: 0, expired: 0, pending: 0 };
  const durations: number[] = [];

  for (const row of rows) {
    counts.sent += 1;

    switch (row.status) {
      case 'COMPLETED':
        counts.completed += 1;
        break;
      case 'REJECTED':
        counts.declined += 1;
        break;
      case 'CANCELLED':
        counts.cancelled += 1;
        break;
      case 'PENDING':
        if (row.isExpired) {
          counts.expired += 1;
        } else {
          counts.pending += 1;
        }
        break;
      default:
        break;
    }

    const duration = getTimeToCompleteMs(row);

    if (duration !== null) {
      durations.push(duration);
    }
  }

  return {
    ...counts,
    completionRate: counts.sent === 0 ? null : Math.round((counts.completed / counts.sent) * 1000) / 10,
    timeToComplete: computeDurationStats(durations),
  };
};

export type TUsageReportMember = {
  userId: number;
  name: string | null;
  email: string;
};

/**
 * One summary per current member, including members with nothing sent. Documents owned by people
 * who are no longer members count in the overall summary but not here.
 */
export const summarizeUsageByMember = (members: TUsageReportMember[], rows: TUsageReportDocumentRow[]) => {
  const rowsByOwner = new Map<number, TUsageReportDocumentRow[]>();

  for (const row of rows) {
    const list = rowsByOwner.get(row.ownerUserId) ?? [];
    list.push(row);
    rowsByOwner.set(row.ownerUserId, list);
  }

  return members
    .map((member) => ({ ...member, ...summarizeUsageRows(rowsByOwner.get(member.userId) ?? []) }))
    .sort(
      (a, b) =>
        b.sent - a.sent || (a.name || a.email).localeCompare(b.name || b.email, undefined, { sensitivity: 'base' }),
    );
};

/** Hours with one decimal, for tables and CSV. */
export const formatDurationHours = (ms: number | null) => (ms === null ? null : Math.round(ms / 360_000) / 10);

/**
 * Short, readable duration: minutes under an hour, hours under two days, days after that.
 */
export const formatDurationShort = (ms: number | null): string | null => {
  if (ms === null) {
    return null;
  }

  const minutes = ms / 60_000;

  if (minutes < 1) {
    return '< 1 min';
  }

  if (minutes < 60) {
    return `${Math.round(minutes)} min`;
  }

  const hours = minutes / 60;

  if (hours < 48) {
    return `${Math.round(hours * 10) / 10} h`;
  }

  return `${Math.round((hours / 24) * 10) / 10} d`;
};

export type TUsageReportMemberSummary = TUsageReportMember & TUsageReportSummary;

export const buildMemberUsageCsv = (members: TUsageReportMemberSummary[]) =>
  toCsv(
    [
      'Name',
      'Email',
      'Sent',
      'Completed',
      'Declined',
      'Expired',
      'Cancelled',
      'Pending',
      'Completion rate (%)',
      'Average hours to complete',
      'Median hours to complete',
    ],
    members.map((member) => [
      member.name ?? '',
      member.email,
      member.sent,
      member.completed,
      member.declined,
      member.expired,
      member.cancelled,
      member.pending,
      member.completionRate,
      formatDurationHours(member.timeToComplete.averageMs),
      formatDurationHours(member.timeToComplete.medianMs),
    ]),
  );

export const getUsageDocumentStatusLabel = (row: Pick<TUsageReportDocumentRow, 'status' | 'isExpired'>) => {
  if (row.status === 'REJECTED') {
    return 'Declined';
  }

  if (row.status === 'PENDING') {
    return row.isExpired ? 'Expired' : 'Pending';
  }

  return row.status.charAt(0) + row.status.slice(1).toLowerCase();
};

export const buildDocumentUsageCsv = (
  documents: TUsageReportDocumentRow[],
  { includeTeam }: { includeTeam: boolean },
) =>
  toCsv(
    [
      'Document ID',
      'Envelope ID',
      'Title',
      ...(includeTeam ? ['Team'] : []),
      'Owner name',
      'Owner email',
      'Status',
      'Recipients',
      'Sent at (UTC)',
      'Completed at (UTC)',
      'Hours to complete',
    ],
    documents.map((document) => [
      document.documentId,
      document.envelopeId,
      document.title,
      ...(includeTeam ? [document.teamName] : []),
      document.ownerName ?? '',
      document.ownerEmail,
      getUsageDocumentStatusLabel(document),
      document.recipientCount,
      document.sentAt,
      document.completedAt,
      formatDurationHours(getTimeToCompleteMs(document)),
    ]),
  );
