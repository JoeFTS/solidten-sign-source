import { describe, expect, it } from 'vitest';

import { assertSessionFreshForCredentialChange, CHANGE_SIGN_IN_AGAIN } from './credential-step-up';

const now = new Date('2026-11-21T12:00:00Z');
const fresh = new Date(now.getTime() - 60_000);
const stale = new Date(now.getTime() - 11 * 60_000);

const check = (session: Parameters<typeof assertSessionFreshForCredentialChange>[0]) => () =>
  assertSessionFreshForCredentialChange(session, now, CHANGE_SIGN_IN_AGAIN);

describe('assertSessionFreshForCredentialChange (AUD-C10 follow-up)', () => {
  it('passes a recent sign-in of the user', () => {
    expect(check({ createdAt: fresh, isEmbed: false, stInPersonSessionId: null })).not.toThrow();
  });

  it('refuses no session (an API token)', () => {
    expect(check(null)).toThrow(/sign in again to change how you sign in/);
  });

  it('refuses a sign-in older than 10 minutes', () => {
    expect(check({ createdAt: stale })).toThrow(/sign in again/);
  });

  it('refuses an embed sign-in, even a recent one', () => {
    expect(check({ createdAt: fresh, isEmbed: true })).toThrow(/sign in again/);
  });

  it('refuses a device locked to in-person signing', () => {
    expect(check({ createdAt: fresh, stInPersonSessionId: 'ips_1' })).toThrow(/sign in again/);
  });
});
