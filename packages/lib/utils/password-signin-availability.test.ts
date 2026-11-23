import { afterEach, describe, expect, it } from 'vitest';

import { isSigninEnabledForProvider, isSignupEnabledForProvider } from '../constants/auth';
import {
  computePasswordSigninAvailable,
  computePasswordSignupAvailable,
  isPasswordSigninAvailable,
  isPasswordSignupAvailable,
} from './password-signin-availability';
import { computeSignupAvailable } from './signup-availability';

const FLAGS = [
  'NEXT_PUBLIC_DISABLE_SIGNIN',
  'NEXT_PUBLIC_DISABLE_EMAIL_PASSWORD_SIGNIN',
  'NEXT_PUBLIC_DISABLE_SIGNUP',
  'NEXT_PUBLIC_DISABLE_EMAIL_PASSWORD_SIGNUP',
] as const;

const saved = Object.fromEntries(FLAGS.map((flag) => [flag, process.env[flag]]));

afterEach(() => {
  for (const flag of FLAGS) {
    if (saved[flag] === undefined) {
      delete process.env[flag];
    } else {
      process.env[flag] = saved[flag];
    }
  }
});

const setEnv = (values: Partial<Record<(typeof FLAGS)[number], string>>) => {
  for (const flag of FLAGS) {
    if (values[flag] === undefined) {
      delete process.env[flag];
    } else {
      process.env[flag] = values[flag];
    }
  }
};

describe('computePasswordSigninAvailable', () => {
  it('is on when nothing turns it off', () => {
    expect(computePasswordSigninAvailable({})).toBe(true);
  });

  it('is off with NEXT_PUBLIC_DISABLE_EMAIL_PASSWORD_SIGNIN=true', () => {
    expect(computePasswordSigninAvailable({ NEXT_PUBLIC_DISABLE_EMAIL_PASSWORD_SIGNIN: 'true' })).toBe(false);
  });

  it('is off with the sign-in kill switch', () => {
    expect(computePasswordSigninAvailable({ NEXT_PUBLIC_DISABLE_SIGNIN: 'true' })).toBe(false);
  });

  it('reads only the exact value "true"', () => {
    expect(computePasswordSigninAvailable({ NEXT_PUBLIC_DISABLE_EMAIL_PASSWORD_SIGNIN: 'false' })).toBe(true);
    expect(computePasswordSigninAvailable({ NEXT_PUBLIC_DISABLE_EMAIL_PASSWORD_SIGNIN: '' })).toBe(true);
  });
});

describe('computePasswordSignupAvailable', () => {
  it('is on when nothing turns it off', () => {
    expect(computePasswordSignupAvailable({})).toBe(true);
  });

  it.each([
    'NEXT_PUBLIC_DISABLE_SIGNUP',
    'NEXT_PUBLIC_DISABLE_EMAIL_PASSWORD_SIGNUP',
    'NEXT_PUBLIC_DISABLE_EMAIL_PASSWORD_SIGNIN',
  ])('is off with %s=true', (flag) => {
    expect(computePasswordSignupAvailable({ [flag]: 'true' })).toBe(false);
  });

  it('takes away the e-mail part of computeSignupAvailable when password sign-in is off', () => {
    expect(computeSignupAvailable({})).toBe(true);
    expect(computeSignupAvailable({ NEXT_PUBLIC_DISABLE_EMAIL_PASSWORD_SIGNIN: 'true' })).toBe(false);
  });
});

describe('server-side readers', () => {
  const combos = [
    {},
    { NEXT_PUBLIC_DISABLE_EMAIL_PASSWORD_SIGNIN: 'true' },
    { NEXT_PUBLIC_DISABLE_SIGNIN: 'true' },
    { NEXT_PUBLIC_DISABLE_SIGNUP: 'true' },
    { NEXT_PUBLIC_DISABLE_EMAIL_PASSWORD_SIGNUP: 'true' },
    { NEXT_PUBLIC_DISABLE_EMAIL_PASSWORD_SIGNIN: 'true', NEXT_PUBLIC_DISABLE_SIGNUP: 'true' },
  ];

  it.each(combos)('isPasswordSigninAvailable agrees with isSigninEnabledForProvider("email") for %o', (values) => {
    setEnv(values);
    expect(isPasswordSigninAvailable()).toBe(isSigninEnabledForProvider('email'));
  });

  it.each(combos)('isSignupEnabledForProvider("email") follows isPasswordSignupAvailable for %o', (values) => {
    setEnv(values);
    expect(isSignupEnabledForProvider('email')).toBe(isPasswordSignupAvailable());
  });

  it('the production settings turn both off', () => {
    setEnv({ NEXT_PUBLIC_DISABLE_SIGNUP: 'true', NEXT_PUBLIC_DISABLE_EMAIL_PASSWORD_SIGNIN: 'true' });
    expect(isPasswordSigninAvailable()).toBe(false);
    expect(isSignupEnabledForProvider('email')).toBe(false);
  });

  it('password sign-in off alone also turns e-mail sign-up off', () => {
    setEnv({ NEXT_PUBLIC_DISABLE_EMAIL_PASSWORD_SIGNIN: 'true' });
    expect(isSignupEnabledForProvider('email')).toBe(false);
  });
});
