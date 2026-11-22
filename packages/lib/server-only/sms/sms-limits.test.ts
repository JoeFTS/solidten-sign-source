import { describe, expect, it } from 'vitest';

import {
  exceedsSmsLimits,
  isDeniedNanpNumber,
  isSmsCountryAllowed,
  parseDeniedNanpAreaCodes,
  parseSmsCountryCodes,
  SMS_DEFAULT_DENIED_NANP_AREA_CODES,
} from './sms-limits';

describe('parseSmsCountryCodes', () => {
  it('defaults to +1 when unset or invalid', () => {
    expect(parseSmsCountryCodes(undefined)).toEqual(['1']);
    expect(parseSmsCountryCodes('')).toEqual(['1']);
    expect(parseSmsCountryCodes('abc, 0, 12345')).toEqual(['1']);
  });

  it('reads a list with or without plus signs', () => {
    expect(parseSmsCountryCodes('1, +44,353')).toEqual(['1', '44', '353']);
  });
});

describe('isSmsCountryAllowed', () => {
  it('allows only the listed calling codes', () => {
    expect(isSmsCountryAllowed('+14155550100', ['1'])).toBe(true);
    expect(isSmsCountryAllowed('+8823456789012', ['1'])).toBe(false);
    expect(isSmsCountryAllowed('+2348012345678', ['1'])).toBe(false);
    expect(isSmsCountryAllowed('+447700900123', ['1', '44'])).toBe(true);
  });
});

describe('exceedsSmsLimits', () => {
  const limits = { teamHourly: 200, recipientDaily: 5, serverDaily: 1000 };

  it('stops at the server-wide daily cap even when the team and recipient are under theirs', () => {
    expect(exceedsSmsLimits({ team: 0, recipient: 0, server: 999 }, limits)).toBe(false);
    expect(exceedsSmsLimits({ team: 0, recipient: 0, server: 1000 }, limits)).toBe(true);
  });

  it('keeps the team and recipient limits', () => {
    expect(exceedsSmsLimits({ team: 200, recipient: 0, server: 0 }, limits)).toBe(true);
    expect(exceedsSmsLimits({ team: 0, recipient: 5, server: 0 }, limits)).toBe(true);
  });
});

// RT2-L4: "+1 only" must not mean premium-rate or Caribbean numbers.
describe('NANP area codes', () => {
  const denied = SMS_DEFAULT_DENIED_NANP_AREA_CODES;

  it.each([
    '+19005550100',
    '+19765550100',
    '+18765550100',
    '+18095550100',
    '+12425550100',
    '+14415550100',
  ])('refuses %s by default', (e164) => {
    expect(isDeniedNanpNumber(e164, denied)).toBe(true);
    expect(isSmsCountryAllowed(e164, ['1'], denied)).toBe(false);
  });

  it.each([
    '+14155550100',
    '+12125550100',
    '+14165550100',
    '+17875550100',
    '+16715550100',
  ])('allows US, Canada and US territories: %s', (e164) => {
    expect(isSmsCountryAllowed(e164, ['1'], denied)).toBe(true);
  });

  it('reads the deny list from the environment value', () => {
    expect(parseDeniedNanpAreaCodes(undefined)).toEqual(SMS_DEFAULT_DENIED_NANP_AREA_CODES);
    expect(parseDeniedNanpAreaCodes('none')).toEqual([]);
    expect(parseDeniedNanpAreaCodes('900, 415,abc')).toEqual(['900', '415']);
  });
});
