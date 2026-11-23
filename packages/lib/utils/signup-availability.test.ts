import { describe, expect, it } from 'vitest';

import { computeSignupAvailable } from './signup-availability';

describe('sign-up availability (F-6)', () => {
  it('is on by default (e-mail sign-up)', () => {
    expect(computeSignupAvailable({})).toBe(true);
  });

  it('the master switch turns it off, also with a configured provider', () => {
    expect(
      computeSignupAvailable({
        NEXT_PUBLIC_DISABLE_SIGNUP: 'true',
        NEXT_PRIVATE_GOOGLE_CLIENT_ID: 'id',
        NEXT_PRIVATE_GOOGLE_CLIENT_SECRET: 'secret',
      }),
    ).toBe(false);
  });

  it('e-mail sign-up off and no provider configured: off', () => {
    expect(computeSignupAvailable({ NEXT_PUBLIC_DISABLE_EMAIL_PASSWORD_SIGNUP: 'true' })).toBe(false);
  });

  it('e-mail sign-up off but a configured provider allows it: on', () => {
    expect(
      computeSignupAvailable({
        NEXT_PUBLIC_DISABLE_EMAIL_PASSWORD_SIGNUP: 'true',
        NEXT_PRIVATE_OIDC_WELL_KNOWN: 'https://idp.example/.well-known',
        NEXT_PRIVATE_OIDC_CLIENT_ID: 'id',
        NEXT_PRIVATE_OIDC_CLIENT_SECRET: 'secret',
      }),
    ).toBe(true);
  });

  it('a provider whose sign-up is off does not count', () => {
    expect(
      computeSignupAvailable({
        NEXT_PUBLIC_DISABLE_EMAIL_PASSWORD_SIGNUP: 'true',
        NEXT_PRIVATE_GOOGLE_CLIENT_ID: 'id',
        NEXT_PRIVATE_GOOGLE_CLIENT_SECRET: 'secret',
        NEXT_PUBLIC_DISABLE_GOOGLE_SIGNUP: 'true',
      }),
    ).toBe(false);
  });
});
