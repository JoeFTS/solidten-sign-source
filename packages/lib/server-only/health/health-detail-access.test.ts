import { describe, expect, it } from 'vitest';

import { canSeeHealthDetail } from './health-detail-access';

describe('canSeeHealthDetail', () => {
  it('with a token set, needs exactly that bearer token', () => {
    expect(canSeeHealthDetail(new Headers({ authorization: 'Bearer s3cret' }), 's3cret')).toBe(true);
    expect(canSeeHealthDetail(new Headers({ authorization: 'Bearer wrong!' }), 's3cret')).toBe(false);
    // A direct call without the token is not enough once a token is set.
    expect(canSeeHealthDetail(new Headers(), 's3cret')).toBe(false);
  });

  it('without a token, serves detail only to direct calls (no X-Forwarded-For)', () => {
    expect(canSeeHealthDetail(new Headers(), undefined)).toBe(true);
    expect(canSeeHealthDetail(new Headers({ 'x-forwarded-for': '203.0.113.5' }), undefined)).toBe(false);
  });
});
