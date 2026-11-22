import { describe, expect, it } from 'vitest';

import {
  buildDocumentUsageCsv,
  computeDurationStats,
  formatDurationShort,
  getTimeToCompleteMs,
  summarizeUsageByMember,
  summarizeUsageRows,
  type TUsageReportDocumentRow,
} from './usage-report';

const HOUR = 60 * 60 * 1000;
const SENT = new Date('2026-11-01T00:00:00Z');

let nextId = 1;

const row = (overrides: Partial<TUsageReportDocumentRow>): TUsageReportDocumentRow => {
  const id = nextId++;

  return {
    envelopeId: `envelope_${id}`,
    documentId: id,
    title: `Doc ${id}`,
    status: 'PENDING',
    ownerUserId: 1,
    ownerName: 'Owner',
    ownerEmail: 'owner@example.com',
    teamId: 1,
    teamName: 'Team',
    sentAt: SENT,
    completedAt: null,
    isExpired: false,
    recipientCount: 1,
    ...overrides,
  };
};

const completedAfter = (hours: number, ownerUserId = 1) =>
  row({ status: 'COMPLETED', completedAt: new Date(SENT.getTime() + hours * HOUR), ownerUserId });

describe('computeDurationStats', () => {
  it('returns nulls for no data', () => {
    expect(computeDurationStats([])).toEqual({ count: 0, averageMs: null, medianMs: null });
  });

  it('takes the middle value for an odd count and the mean of the two middle values for an even count', () => {
    expect(computeDurationStats([5, 1, 3])).toEqual({ count: 3, averageMs: 3, medianMs: 3 });
    expect(computeDurationStats([4, 1, 3, 2])).toEqual({ count: 4, averageMs: 3, medianMs: 3 });
    expect(computeDurationStats([1, 2, 3, 100])).toEqual({ count: 4, averageMs: 27, medianMs: 3 });
  });

  it('ignores negative and non-finite values', () => {
    expect(computeDurationStats([-5, Number.NaN, 10])).toEqual({ count: 1, averageMs: 10, medianMs: 10 });
  });
});

describe('getTimeToCompleteMs', () => {
  it('only measures completed documents with a completion after the send', () => {
    expect(getTimeToCompleteMs(completedAfter(2))).toBe(2 * HOUR);
    expect(getTimeToCompleteMs(row({ status: 'PENDING' }))).toBeNull();
    expect(getTimeToCompleteMs(row({ status: 'COMPLETED', completedAt: null }))).toBeNull();
    expect(getTimeToCompleteMs(row({ status: 'COMPLETED', completedAt: new Date(SENT.getTime() - 1) }))).toBeNull();
  });
});

describe('summarizeUsageRows', () => {
  it('counts each outcome once and splits expired from pending', () => {
    const summary = summarizeUsageRows([
      completedAfter(1),
      completedAfter(3),
      completedAfter(20),
      row({ status: 'REJECTED' }),
      row({ status: 'CANCELLED' }),
      row({ status: 'PENDING', isExpired: true }),
      row({ status: 'PENDING' }),
      row({ status: 'PENDING' }),
    ]);

    expect(summary).toEqual({
      sent: 8,
      completed: 3,
      declined: 1,
      cancelled: 1,
      expired: 1,
      pending: 2,
      completionRate: 37.5,
      timeToComplete: { count: 3, averageMs: 8 * HOUR, medianMs: 3 * HOUR },
    });
  });

  it('returns zeros and nulls for an empty range', () => {
    expect(summarizeUsageRows([])).toMatchObject({
      sent: 0,
      completionRate: null,
      timeToComplete: { averageMs: null },
    });
  });
});

describe('summarizeUsageByMember', () => {
  it('includes members with no documents and leaves out former members', () => {
    const members = summarizeUsageByMember(
      [
        { userId: 1, name: 'Ann', email: 'ann@example.com' },
        { userId: 2, name: null, email: 'bob@example.com' },
      ],
      [completedAfter(2, 1), completedAfter(4, 1), completedAfter(9, 99)],
    );

    expect(members.map((m) => [m.email, m.sent, m.timeToComplete.medianMs])).toEqual([
      ['ann@example.com', 2, 3 * HOUR],
      ['bob@example.com', 0, null],
    ]);
  });
});

describe('formatDurationShort', () => {
  it('picks a readable unit', () => {
    expect(formatDurationShort(null)).toBeNull();
    expect(formatDurationShort(10_000)).toBe('< 1 min');
    expect(formatDurationShort(25 * 60_000)).toBe('25 min');
    expect(formatDurationShort(5.25 * HOUR)).toBe('5.3 h');
    expect(formatDurationShort(72 * HOUR)).toBe('3 d');
  });
});

describe('buildDocumentUsageCsv', () => {
  it('labels statuses the way the screen does and guards formula titles', () => {
    const csv = buildDocumentUsageCsv(
      [row({ title: '=cmd|"/c calc"!A1', status: 'REJECTED' }), row({ status: 'PENDING', isExpired: true })],
      { includeTeam: true },
    );

    const lines = csv.replace(/^﻿/, '').split('\r\n');

    expect(lines[0]).toBe(
      '"Document ID","Envelope ID","Title","Team","Owner name","Owner email","Status","Recipients","Sent at (UTC)","Completed at (UTC)","Hours to complete"',
    );
    expect(lines[1]).toContain(`"'=cmd|""/c calc""!A1"`);
    expect(lines[1]).toContain(',"Declined",');
    expect(lines[2]).toContain(',"Expired",');
  });
});
