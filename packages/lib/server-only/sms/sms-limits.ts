import { AppError, AppErrorCode } from '../../errors/app-error';
import { env } from '../../utils/env';
import { readQuotaEnv } from '../rate-limit/daily-quota';

/**
 * Solid Ten Sign (S-M4): where and how much this server texts.
 *
 * - NEXT_PRIVATE_ST_SMS_ALLOWED_COUNTRY_CODES: comma-separated country calling codes a
 *   number may start with, without "+". Default "1" (US and Canada). Keeps premium and
 *   international numbers out.
 * - NEXT_PRIVATE_ST_SMS_DAILY_CAP: most texts the whole server sends in 24 hours.
 *   Default 1000.
 * - NEXT_PRIVATE_ST_SMS_DENIED_NANP_AREA_CODES (RT2-L4): +1 area codes refused even though
 *   +1 is allowed, comma-separated. Default SMS_DEFAULT_DENIED_NANP_AREA_CODES: the
 *   premium-rate 900 and 976, and the North American Numbering Plan countries outside the
 *   US and Canada (Caribbean and Bermuda), which are billed as international. US
 *   territories (Puerto Rico, USVI, Guam, Northern Marianas, American Samoa) stay allowed.
 *   Set "none" to deny no area code.
 */

export const SMS_DEFAULT_ALLOWED_COUNTRY_CODES = ['1'];
export const SMS_DAILY_CAP_DEFAULT = 1000;

export const parseSmsCountryCodes = (value: string | undefined) => {
  const codes = (value ?? '')
    .split(',')
    .map((code) => code.trim().replace(/^\+/, ''))
    .filter((code) => /^[1-9]\d{0,2}$/.test(code));

  return codes.length > 0 ? codes : SMS_DEFAULT_ALLOWED_COUNTRY_CODES;
};

export const getAllowedSmsCountryCodes = () => parseSmsCountryCodes(env('NEXT_PRIVATE_ST_SMS_ALLOWED_COUNTRY_CODES'));

export const isSmsCountryAllowed = (
  e164: string,
  codes = getAllowedSmsCountryCodes(),
  deniedAreaCodes = getDeniedNanpAreaCodes(),
) => codes.some((code) => e164.startsWith(`+${code}`)) && !isDeniedNanpNumber(e164, deniedAreaCodes);

export const SMS_DEFAULT_DENIED_NANP_AREA_CODES = [
  // Premium rate.
  '900',
  '976',
  // NANP countries outside the US and Canada.
  '242', // Bahamas
  '246', // Barbados
  '264', // Anguilla
  '268', // Antigua and Barbuda
  '284', // British Virgin Islands
  '345', // Cayman Islands
  '441', // Bermuda
  '473', // Grenada
  '649', // Turks and Caicos
  '658', // Jamaica
  '664', // Montserrat
  '721', // Sint Maarten
  '758', // Saint Lucia
  '767', // Dominica
  '784', // Saint Vincent and the Grenadines
  '809', // Dominican Republic
  '829', // Dominican Republic
  '849', // Dominican Republic
  '868', // Trinidad and Tobago
  '869', // Saint Kitts and Nevis
  '876', // Jamaica
];

export const parseDeniedNanpAreaCodes = (value: string | undefined) => {
  const trimmed = (value ?? '').trim();

  if (trimmed === '') {
    return SMS_DEFAULT_DENIED_NANP_AREA_CODES;
  }

  if (trimmed.toLowerCase() === 'none') {
    return [];
  }

  return trimmed
    .split(',')
    .map((code) => code.trim())
    .filter((code) => /^\d{3}$/.test(code));
};

export const getDeniedNanpAreaCodes = () => parseDeniedNanpAreaCodes(env('NEXT_PRIVATE_ST_SMS_DENIED_NANP_AREA_CODES'));

/** A +1 number whose area code is on the deny list. */
export const isDeniedNanpNumber = (e164: string, deniedAreaCodes = getDeniedNanpAreaCodes()) =>
  /^\+1\d{10}$/.test(e164) && deniedAreaCodes.includes(e164.slice(2, 5));

export const getSmsDailyCap = () => readQuotaEnv(env('NEXT_PRIVATE_ST_SMS_DAILY_CAP'), SMS_DAILY_CAP_DEFAULT);

export type TSmsSendCounts = {
  /** Texts by the team in the last hour. */
  team: number;
  /** Texts to the recipient in the last 24 hours. */
  recipient: number;
  /** Texts by the whole server in the last 24 hours. */
  server: number;
};

export const exceedsSmsLimits = (
  counts: TSmsSendCounts,
  limits: { teamHourly: number; recipientDaily: number; serverDaily: number },
) =>
  counts.team >= limits.teamHourly || counts.recipient >= limits.recipientDaily || counts.server >= limits.serverDaily;

/** Refuse a number outside the allowed countries, with the list in the message. */
export const assertSmsCountryAllowed = (e164: string) => {
  if (isSmsCountryAllowed(e164)) {
    return;
  }

  if (isDeniedNanpNumber(e164)) {
    throw new AppError(AppErrorCode.INVALID_BODY, {
      message: 'Text messages cannot go to premium-rate numbers or to +1 numbers outside the US and Canada.',
    });
  }

  const codes = getAllowedSmsCountryCodes()
    .map((code) => `+${code}`)
    .join(', ');

  throw new AppError(AppErrorCode.INVALID_BODY, {
    message: `Text messages can only go to numbers starting with ${codes}.`,
  });
};
