import { describe, expect, it } from 'vitest';

import { maskPhoneNumber, normalizePhoneNumber } from './phone';

describe('normalizePhoneNumber', () => {
  it.each([
    ['+1 (415) 555-2671', '+14155552671'],
    ['415.555.2671', '+14155552671'],
    ['1-415-555-2671', '+14155552671'],
    ['+44 20 7946 0958', '+442079460958'],
    ['0044 20 7946 0958', '+442079460958'],
  ])('turns %s into %s', (input, expected) => {
    expect(normalizePhoneNumber(input)).toEqual({ success: true, e164: expected });
  });

  it.each([
    ['', 'EMPTY'],
    ['   ', 'EMPTY'],
    ['555-2671', 'INVALID'],
    ['+0 123 456 789', 'INVALID'],
    ['+1 015 555 2671', 'INVALID'], // NANP area codes never start with 0 or 1.
    ['+1 415 155 2671', 'INVALID'], // NANP exchanges never start with 0 or 1.
    ['+1234567890123456', 'INVALID'], // More than 15 digits.
    ['415-555-2671 ext 2', 'INVALID'],
    ['javascript:alert(1)', 'INVALID'],
  ])('rejects %j', (input, error) => {
    expect(normalizePhoneNumber(input)).toEqual({ success: false, error });
  });
});

describe('maskPhoneNumber', () => {
  it('keeps only the last four digits', () => {
    expect(maskPhoneNumber('+14155552671')).toBe('*******2671');
  });

  it('masks very short values completely', () => {
    expect(maskPhoneNumber('+123')).toBe('***');
  });
});
