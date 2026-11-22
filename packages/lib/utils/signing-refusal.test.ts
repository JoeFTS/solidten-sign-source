import { describe, expect, it } from 'vitest';

import { describeSigningRefusal } from './signing-refusal';

describe('describeSigningRefusal', () => {
  it.each([
    ['PUBLIC_FORM_CLOSED', 'This form is closed.'],
    ['PUBLIC_FORM_FULL', 'This form has reached its maximum number of responses.'],
    ['PUBLIC_FORM_NOT_OPEN', 'This form is not open yet.'],
    ['PUBLIC_FORM_RELOAD', 'This page has expired. Reload the page and try again.'],
    ['PUBLIC_FORM_PROOF_USED', 'This email verification was already used. Verify your email address again.'],
    ['INVALID_BODY', '"Hours": Value 1234,5 does not match the number format 123,456,789.00.'],
  ])('shows the server reason for %s', (code, message) => {
    expect(describeSigningRefusal({ code, message, httpStatus: 400 })).toEqual({ kind: 'refused', message });
  });

  it('never tells a closed or full form to try again later', () => {
    for (const code of ['PUBLIC_FORM_CLOSED', 'PUBLIC_FORM_FULL']) {
      expect(describeSigningRefusal({ code, message: 'This form is closed.' })?.message).not.toMatch(/later/i);
    }
  });

  it('says to try again in a moment when the server is busy or the caller is rate limited', () => {
    expect(describeSigningRefusal({ code: 'SERVER_BUSY', message: 'The server is busy, try again.' })).toEqual({
      kind: 'busy',
      message: 'The server is busy. Please try again in a moment.',
    });
    expect(describeSigningRefusal({ code: 'UNKNOWN_ERROR', message: 'x', httpStatus: 503 })?.kind).toBe('busy');
    expect(describeSigningRefusal({ code: 'UNKNOWN_ERROR', message: 'Too many requests', httpStatus: 429 })).toEqual({
      kind: 'rateLimited',
      message: 'Too many attempts. Please wait a moment and try again.',
    });
    expect(
      describeSigningRefusal({
        code: 'TOO_MANY_REQUESTS',
        message: 'Too many codes were sent today. Please try again tomorrow.',
      })?.message,
    ).toBe('Too many codes were sent today. Please try again tomorrow.');
  });

  it('leaves unexpected errors to the generic text', () => {
    expect(describeSigningRefusal({ code: 'UNKNOWN_ERROR', message: 'Prisma P2002 ...', httpStatus: 500 })).toBeNull();
    expect(describeSigningRefusal({ code: 'PUBLIC_FORM_CLOSED', message: '' })).toBeNull();
  });
});
