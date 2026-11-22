export type TNormalizePhoneResult = { success: true; e164: string } | { success: false; error: 'EMPTY' | 'INVALID' };

const E164_REGEX = /^\+[1-9]\d{7,14}$/;

// North American Numbering Plan: area code and exchange both start with 2-9.
const NANP_REGEX = /^\+1[2-9]\d{2}[2-9]\d{6}$/;

/**
 * Turn what a sender typed into an E.164 number ("+15551234567").
 *
 * Numbers without a leading "+" or "00" are read as North American numbers, because Solid Ten
 * Sign serves US customers. Anyone else must type the country code.
 */
export const normalizePhoneNumber = (input: string): TNormalizePhoneResult => {
  const trimmed = input.trim();

  if (trimmed === '') {
    return { success: false, error: 'EMPTY' };
  }

  if (!/^[+\d\s().-]+$/.test(trimmed)) {
    return { success: false, error: 'INVALID' };
  }

  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');

  let candidate: string;

  if (hasPlus) {
    candidate = `+${digits}`;
  } else if (digits.startsWith('00')) {
    candidate = `+${digits.slice(2)}`;
  } else if (digits.length === 10) {
    candidate = `+1${digits}`;
  } else if (digits.length === 11 && digits.startsWith('1')) {
    candidate = `+${digits}`;
  } else {
    return { success: false, error: 'INVALID' };
  }

  if (!E164_REGEX.test(candidate)) {
    return { success: false, error: 'INVALID' };
  }

  if (candidate.startsWith('+1') && !NANP_REGEX.test(candidate)) {
    return { success: false, error: 'INVALID' };
  }

  return { success: true, e164: candidate };
};

export const isE164PhoneNumber = (value: string) => normalizePhoneNumber(value).success && value.startsWith('+');

/**
 * Keep only the last four digits so audit logs and the UI never show a full number.
 */
export const maskPhoneNumber = (e164: string) => {
  const digits = e164.replace(/\D/g, '');

  if (digits.length <= 4) {
    return '*'.repeat(digits.length);
  }

  return `${'*'.repeat(digits.length - 4)}${digits.slice(-4)}`;
};
