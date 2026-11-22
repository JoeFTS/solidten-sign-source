import { describe, expect, it } from 'vitest';

import { isFakeSmsProviderAllowed } from './sms-config';

describe('isFakeSmsProviderAllowed', () => {
  it('refuses the fake provider in production', () => {
    expect(isFakeSmsProviderAllowed('production', undefined)).toBe(false);
    expect(isFakeSmsProviderAllowed('production', 'false')).toBe(false);
  });

  it('allows it in production only with the explicit switch', () => {
    expect(isFakeSmsProviderAllowed('production', 'true')).toBe(true);
  });

  it('allows it outside production', () => {
    expect(isFakeSmsProviderAllowed('development', undefined)).toBe(true);
    expect(isFakeSmsProviderAllowed('test', undefined)).toBe(true);
  });
});
