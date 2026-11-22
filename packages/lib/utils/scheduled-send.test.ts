import { describe, expect, it } from 'vitest';

import {
  getScheduledSendSweepAction,
  getStaleScheduledSendOutcome,
  resolveScheduledSendTime,
  SCHEDULED_SEND_STALE_CLAIM_MS,
} from './scheduled-send';

const now = new Date('2026-03-01T12:00:00.000Z');

describe('resolveScheduledSendTime', () => {
  it('converts the sender wall clock to UTC using their timezone', () => {
    const result = resolveScheduledSendTime({
      localDateTime: '2026-03-02T09:00',
      timezone: 'America/Los_Angeles',
      now,
    });

    expect(result).toEqual({ ok: true, scheduledAt: new Date('2026-03-02T17:00:00.000Z') });
  });

  it('uses the summer offset after the spring daylight-saving change', () => {
    const result = resolveScheduledSendTime({
      localDateTime: '2026-03-09T09:00',
      timezone: 'America/Los_Angeles',
      now,
    });

    expect(result).toEqual({ ok: true, scheduledAt: new Date('2026-03-09T16:00:00.000Z') });
  });

  it('refuses a local time that does not exist because clocks jump forward', () => {
    const result = resolveScheduledSendTime({
      localDateTime: '2026-03-08T02:30',
      timezone: 'America/Los_Angeles',
      now,
    });

    expect(result).toEqual({ ok: false, error: 'NONEXISTENT_LOCAL_TIME' });
  });

  it('resolves the repeated hour when clocks go back to its first occurrence', () => {
    const result = resolveScheduledSendTime({
      localDateTime: '2026-11-01T01:30',
      timezone: 'America/Los_Angeles',
      now,
    });

    expect(result).toEqual({ ok: true, scheduledAt: new Date('2026-11-01T08:30:00.000Z') });
  });

  it('refuses a time in the past and a time less than a minute ahead', () => {
    expect(resolveScheduledSendTime({ localDateTime: '2026-03-01T11:59', timezone: 'Etc/UTC', now })).toEqual({
      ok: false,
      error: 'IN_PAST',
    });

    expect(resolveScheduledSendTime({ localDateTime: '2026-03-01T12:00', timezone: 'Etc/UTC', now })).toEqual({
      ok: false,
      error: 'IN_PAST',
    });
  });

  it('refuses a time more than a year ahead', () => {
    expect(resolveScheduledSendTime({ localDateTime: '2027-03-02T12:00', timezone: 'Etc/UTC', now })).toEqual({
      ok: false,
      error: 'TOO_FAR',
    });
  });

  it('refuses an unknown timezone and malformed input', () => {
    expect(resolveScheduledSendTime({ localDateTime: '2026-03-02T09:00', timezone: 'Mars/Base', now })).toEqual({
      ok: false,
      error: 'INVALID_TIMEZONE',
    });

    expect(resolveScheduledSendTime({ localDateTime: '2026-02-30T09:00', timezone: 'Etc/UTC', now })).toEqual({
      ok: false,
      error: 'INVALID_DATE',
    });

    expect(resolveScheduledSendTime({ localDateTime: '2026-03-02 09:00', timezone: 'Etc/UTC', now })).toEqual({
      ok: false,
      error: 'INVALID_DATE',
    });
  });
});

describe('getScheduledSendSweepAction', () => {
  it('claims a scheduled row at or after its time and skips it before', () => {
    expect(getScheduledSendSweepAction({ status: 'SCHEDULED', scheduledAt: now, claimedAt: null }, now)).toBe('CLAIM');

    expect(
      getScheduledSendSweepAction(
        { status: 'SCHEDULED', scheduledAt: new Date(now.getTime() + 1), claimedAt: null },
        now,
      ),
    ).toBe('SKIP');
  });

  it('recovers a claim only once it is stale', () => {
    const fresh = new Date(now.getTime() - SCHEDULED_SEND_STALE_CLAIM_MS + 1000);
    const stale = new Date(now.getTime() - SCHEDULED_SEND_STALE_CLAIM_MS);

    expect(getScheduledSendSweepAction({ status: 'SENDING', scheduledAt: now, claimedAt: fresh }, now)).toBe('SKIP');
    expect(getScheduledSendSweepAction({ status: 'SENDING', scheduledAt: now, claimedAt: stale }, now)).toBe('RECOVER');
  });

  it('never picks up finished rows', () => {
    expect(getScheduledSendSweepAction({ status: 'SENT', scheduledAt: now, claimedAt: now }, now)).toBe('SKIP');
    expect(getScheduledSendSweepAction({ status: 'FAILED', scheduledAt: now, claimedAt: now }, now)).toBe('SKIP');
  });
});

describe('getStaleScheduledSendOutcome', () => {
  it('marks the row sent when the envelope already left draft', () => {
    expect(getStaleScheduledSendOutcome({ envelopeStatus: 'PENDING', attempts: 1 })).toBe('MARK_SENT');
  });

  it('retries a draft until the attempt limit, then fails', () => {
    expect(getStaleScheduledSendOutcome({ envelopeStatus: 'DRAFT', attempts: 2 })).toBe('RETRY');
    expect(getStaleScheduledSendOutcome({ envelopeStatus: 'DRAFT', attempts: 3 })).toBe('FAIL');
  });

  it('fails when the envelope is gone', () => {
    expect(getStaleScheduledSendOutcome({ envelopeStatus: null, attempts: 1 })).toBe('FAIL');
  });
});
