import { afterEach, describe, expect, it } from 'vitest';

import { assertEmailLinkSigninEnabled } from './email-link-kill-switch';

describe('assertEmailLinkSigninEnabled', () => {
  const previous = process.env.NEXT_PUBLIC_DISABLE_SIGNIN;

  afterEach(() => {
    process.env.NEXT_PUBLIC_DISABLE_SIGNIN = previous;
  });

  it('refuses when NEXT_PUBLIC_DISABLE_SIGNIN is true', () => {
    process.env.NEXT_PUBLIC_DISABLE_SIGNIN = 'true';

    expect(() => assertEmailLinkSigninEnabled()).toThrow('Sign-in is turned off on this server.');
  });

  it('allows otherwise', () => {
    process.env.NEXT_PUBLIC_DISABLE_SIGNIN = '';

    expect(() => assertEmailLinkSigninEnabled()).not.toThrow();
  });
});
