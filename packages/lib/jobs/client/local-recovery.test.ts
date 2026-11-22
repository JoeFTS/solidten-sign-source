import { describe, expect, it } from 'vitest';

import {
  CRASH_RETRY_MINUTES,
  getCrashRetryAt,
  isSuspectCutOff,
  pickPreviouslyFatalToRun,
  sortByRecoveryPriority,
} from './local-recovery';

const now = new Date('2026-11-22T12:00:00Z');
const minutesAfter = (date: Date) => (date.getTime() - now.getTime()) / 60_000;

describe('recovery of jobs that were cut off (LD2-B)', () => {
  it('waits longer after each cut-off attempt', () => {
    expect([1, 2, 3, 4, 5, 9].map((retried) => minutesAfter(getCrashRetryAt(retried, now)))).toEqual([
      1, 5, 15, 60, 240, 240,
    ]);
    expect(CRASH_RETRY_MINUTES[0]).toBeGreaterThan(0);
  });

  it('starts at most one previously fatal job, and none while one is running', () => {
    const rows = [
      { id: 'a', lastCrashedAt: null },
      { id: 'b', lastCrashedAt: now },
      { id: 'c', lastCrashedAt: now },
    ];

    expect(pickPreviouslyFatalToRun(rows, false).map((row) => row.id)).toEqual(['b']);
    expect(pickPreviouslyFatalToRun(rows, true)).toEqual([]);
  });

  it('a poison job never crashes twice in a row without a wait', () => {
    // Attempt 1 crashes; each cut-off is counted at once and the next attempt waits.
    const waits: number[] = [];

    for (let retried = 1; retried <= 3; retried++) {
      waits.push(minutesAfter(getCrashRetryAt(retried, now)));
    }

    expect(waits.every((minutes) => minutes >= 1)).toBe(true);
    expect(waits).toEqual([...waits].sort((a, b) => a - b));
  });
});

describe('recovery after a crash with many jobs in flight (FS3-M1)', () => {
  it('a row cut off once with others is not suspect; twice in a row, or alone, it is', () => {
    expect(isSuspectCutOff(1, false)).toBe(false);
    expect(isSuspectCutOff(2, false)).toBe(true);
    expect(isSuspectCutOff(1, true)).toBe(true);
  });

  it('seals and completion emails are re-run first, the rest in their order', () => {
    const rows = [
      { id: 'a', jobId: 'send.signing.requested.email' },
      { id: 'b', jobId: 'send.document.completed.emails' },
      { id: 'c', jobId: 'internal.retention-sweep' },
      { id: 'd', jobId: 'internal.seal-document' },
    ];

    expect(sortByRecoveryPriority(rows).map((row) => row.id)).toEqual(['d', 'b', 'a', 'c']);
  });
});
