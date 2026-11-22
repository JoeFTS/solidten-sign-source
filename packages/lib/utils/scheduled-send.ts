import { DateTime, IANAZone } from 'luxon';

/**
 * A scheduled send must be at least this far ahead when it is saved, so the
 * sender cannot schedule a time the sweep has already passed.
 */
export const SCHEDULED_SEND_MIN_LEAD_MS = 60 * 1000;

export const SCHEDULED_SEND_MAX_DAYS_AHEAD = 365;

/**
 * A claimed send that has not finished after this long is treated as lost
 * (the process died between claim and send) and is picked up again.
 * sendDocument renders and uploads PDFs, so this is generous.
 */
export const SCHEDULED_SEND_STALE_CLAIM_MS = 10 * 60 * 1000;

/**
 * Lost claims are retried this many times in total before the send is marked failed.
 */
export const SCHEDULED_SEND_MAX_ATTEMPTS = 3;

export type ScheduledSendTimeError =
  | 'INVALID_TIMEZONE'
  | 'INVALID_DATE'
  | 'NONEXISTENT_LOCAL_TIME'
  | 'IN_PAST'
  | 'TOO_FAR';

export type ResolveScheduledSendTimeResult =
  | { ok: true; scheduledAt: Date }
  | { ok: false; error: ScheduledSendTimeError };

/**
 * Turn a wall-clock time picked by the sender (`yyyy-MM-ddTHH:mm`) in their
 * timezone into a UTC instant, and check it is a time we accept.
 *
 * A local time that falls in a daylight-saving gap (for example 02:30 on the
 * night clocks jump from 02:00 to 03:00) does not exist. Luxon would silently
 * move it forward, so it is refused instead. An ambiguous local time (the hour
 * that repeats when clocks go back) resolves to the first occurrence.
 */
export const resolveScheduledSendTime = ({
  localDateTime,
  timezone,
  now,
}: {
  localDateTime: string;
  timezone: string;
  now: Date;
}): ResolveScheduledSendTimeResult => {
  if (!IANAZone.isValidZone(timezone)) {
    return { ok: false, error: 'INVALID_TIMEZONE' };
  }

  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(localDateTime)) {
    return { ok: false, error: 'INVALID_DATE' };
  }

  const zoned = DateTime.fromISO(localDateTime, { zone: timezone });

  if (!zoned.isValid) {
    return { ok: false, error: 'INVALID_DATE' };
  }

  if (zoned.toFormat("yyyy-MM-dd'T'HH:mm") !== localDateTime) {
    return { ok: false, error: 'NONEXISTENT_LOCAL_TIME' };
  }

  // Luxon resolves a repeated hour to its second occurrence. An hour earlier
  // with the same wall-clock reading is the first occurrence.
  const earlier = zoned.minus({ hours: 1 });
  const isRepeatedHour = earlier.toFormat("yyyy-MM-dd'T'HH:mm") === localDateTime;

  const scheduledAt = (isRepeatedHour ? earlier : zoned).toUTC().toJSDate();

  return validateScheduledSendInstant({ scheduledAt, now });
};

export const validateScheduledSendInstant = ({
  scheduledAt,
  now,
}: {
  scheduledAt: Date;
  now: Date;
}): ResolveScheduledSendTimeResult => {
  if (Number.isNaN(scheduledAt.getTime())) {
    return { ok: false, error: 'INVALID_DATE' };
  }

  if (scheduledAt.getTime() < now.getTime() + SCHEDULED_SEND_MIN_LEAD_MS) {
    return { ok: false, error: 'IN_PAST' };
  }

  const maxAhead = SCHEDULED_SEND_MAX_DAYS_AHEAD * 24 * 60 * 60 * 1000;

  if (scheduledAt.getTime() > now.getTime() + maxAhead) {
    return { ok: false, error: 'TOO_FAR' };
  }

  return { ok: true, scheduledAt };
};

type ScheduledSendSweepRow = {
  status: 'SCHEDULED' | 'SENDING' | 'SENT' | 'FAILED';
  scheduledAt: Date;
  claimedAt: Date | null;
};

/**
 * What the sweep should do with a scheduled-send row at `now`.
 *
 * - CLAIM: due and not yet claimed.
 * - RECOVER: claimed so long ago that the worker must have died.
 * - SKIP: not due, still in flight, or finished.
 */
export const getScheduledSendSweepAction = (row: ScheduledSendSweepRow, now: Date): 'CLAIM' | 'RECOVER' | 'SKIP' => {
  if (row.status === 'SCHEDULED') {
    return row.scheduledAt.getTime() <= now.getTime() ? 'CLAIM' : 'SKIP';
  }

  if (row.status === 'SENDING') {
    if (!row.claimedAt) {
      return 'RECOVER';
    }

    return now.getTime() - row.claimedAt.getTime() >= SCHEDULED_SEND_STALE_CLAIM_MS ? 'RECOVER' : 'SKIP';
  }

  return 'SKIP';
};

/**
 * How to settle a lost claim, given what happened to the envelope.
 *
 * If the envelope already left DRAFT the send went through before the crash,
 * so the row is marked sent. Otherwise it is retried until the attempt limit.
 */
export const getStaleScheduledSendOutcome = ({
  envelopeStatus,
  attempts,
}: {
  envelopeStatus: 'DRAFT' | 'PENDING' | 'COMPLETED' | 'REJECTED' | 'CANCELLED' | null;
  attempts: number;
}): 'MARK_SENT' | 'RETRY' | 'FAIL' => {
  if (envelopeStatus === null) {
    return 'FAIL';
  }

  if (envelopeStatus !== 'DRAFT') {
    return 'MARK_SENT';
  }

  return attempts >= SCHEDULED_SEND_MAX_ATTEMPTS ? 'FAIL' : 'RETRY';
};

/**
 * Format a scheduled instant for people: the sender's wall clock plus the zone name,
 * e.g. "2026-03-02 09:00 PST". Falls back to UTC for an unknown zone.
 */
export const formatScheduledSendTime = (scheduledAt: Date | string, timezone: string | null | undefined) => {
  const instant = typeof scheduledAt === 'string' ? DateTime.fromISO(scheduledAt) : DateTime.fromJSDate(scheduledAt);

  const zone = timezone && IANAZone.isValidZone(timezone) ? timezone : 'Etc/UTC';

  return instant.setZone(zone).toFormat('yyyy-MM-dd HH:mm ZZZZ');
};
