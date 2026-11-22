import { describe, expect, it } from 'vitest';

import {
  buildSubmissionSlotWhere,
  checkPublicFormOpenedToken,
  createPublicFormOpenedToken,
  createPublicFormVerifiedProof,
  generatePublicFormCode,
  getPublicFormAvailability,
  getUnverifiedFormBlocker,
  isHoneypotFilled,
  isPublicFormCodeValid,
  isPublicFormVerifiedProofValid,
  PUBLIC_FORM_CODE_PERIOD_MS,
  PUBLIC_FORM_MIN_SUBMIT_SECONDS,
  PUBLIC_FORM_OPENED_TOKEN_MAX_AGE_MS,
  PUBLIC_FORM_VERIFIED_PROOF_MAX_AGE_MS,
} from './public-form';

const KEY = 'test-key';
const now = new Date('2026-11-20T12:00:00.000Z');
const at = (offsetMs: number) => new Date(now.getTime() + offsetMs);

const openForm = {
  opensAt: null,
  closesAt: null,
  closedAt: null,
  maxSubmissions: null,
  submissionCount: 0,
};

describe('public form availability', () => {
  it('is open with no dates and no cap', () => {
    expect(getPublicFormAvailability(openForm, now)).toBe('OPEN');
  });

  it('is not open before the open date and opens at it', () => {
    expect(getPublicFormAvailability({ ...openForm, opensAt: at(1) }, now)).toBe('NOT_OPEN_YET');
    expect(getPublicFormAvailability({ ...openForm, opensAt: now }, now)).toBe('OPEN');
  });

  it('closes at the close date, not one millisecond later', () => {
    expect(getPublicFormAvailability({ ...openForm, closesAt: at(1) }, now)).toBe('OPEN');
    expect(getPublicFormAvailability({ ...openForm, closesAt: now }, now)).toBe('CLOSED');
  });

  it('is closed by the close button even inside the date window', () => {
    expect(getPublicFormAvailability({ ...openForm, closesAt: at(60_000), closedAt: at(-1) }, now)).toBe('CLOSED');
  });

  it('is full once the count reaches the cap', () => {
    expect(getPublicFormAvailability({ ...openForm, maxSubmissions: 2, submissionCount: 1 }, now)).toBe('OPEN');
    expect(getPublicFormAvailability({ ...openForm, maxSubmissions: 2, submissionCount: 2 }, now)).toBe('FULL');
  });

  it('reports closed before full, so a full form that closed says closed', () => {
    expect(
      getPublicFormAvailability({ ...openForm, maxSubmissions: 1, submissionCount: 1, closedAt: at(-1) }, now),
    ).toBe('CLOSED');
  });
});

describe('public form submission slot', () => {
  it('only matches rows still below the cap', () => {
    expect(buildSubmissionSlotWhere('form-1', 3)).toEqual({ id: 'form-1', submissionCount: { lt: 3 } });
  });

  it('has no count condition without a cap', () => {
    expect(buildSubmissionSlotWhere('form-1', null)).toEqual({ id: 'form-1' });
  });
});

describe('public form honeypot', () => {
  it('is tripped by any value', () => {
    expect(isHoneypotFilled('x')).toBe(true);
    expect(isHoneypotFilled(' ')).toBe(true);
  });

  it('is not tripped when empty or missing', () => {
    expect(isHoneypotFilled('')).toBe(false);
    expect(isHoneypotFilled(undefined)).toBe(false);
  });
});

describe('public form opened token', () => {
  const token = createPublicFormOpenedToken({ key: KEY, formId: 'form-1', now });

  it('refuses a submission faster than the minimum time', () => {
    const tooSoon = at(PUBLIC_FORM_MIN_SUBMIT_SECONDS * 1000 - 1);

    expect(checkPublicFormOpenedToken({ key: KEY, formId: 'form-1', token, now: tooSoon })).toBe('TOO_FAST');
  });

  it('accepts a submission after the minimum time', () => {
    const later = at(PUBLIC_FORM_MIN_SUBMIT_SECONDS * 1000);

    expect(checkPublicFormOpenedToken({ key: KEY, formId: 'form-1', token, now: later })).toBe('OK');
  });

  it('expires after a day', () => {
    const tooLate = at(PUBLIC_FORM_OPENED_TOKEN_MAX_AGE_MS + 1);

    expect(checkPublicFormOpenedToken({ key: KEY, formId: 'form-1', token, now: tooLate })).toBe('EXPIRED');
  });

  it('refuses a token with a moved start time', () => {
    const [, signature] = token.split('.');
    const forged = `${now.getTime() - 60_000}.${signature}`;

    expect(checkPublicFormOpenedToken({ key: KEY, formId: 'form-1', token: forged, now })).toBe('INVALID');
  });

  it('refuses a token made for another form or with another key', () => {
    const later = at(60_000);

    expect(checkPublicFormOpenedToken({ key: KEY, formId: 'form-2', token, now: later })).toBe('INVALID');
    expect(checkPublicFormOpenedToken({ key: 'other', formId: 'form-1', token, now: later })).toBe('INVALID');
  });

  it('refuses a missing or malformed token', () => {
    expect(checkPublicFormOpenedToken({ key: KEY, formId: 'form-1', token: undefined, now })).toBe('INVALID');
    expect(checkPublicFormOpenedToken({ key: KEY, formId: 'form-1', token: 'abc', now })).toBe('INVALID');
    expect(checkPublicFormOpenedToken({ key: KEY, formId: 'form-1', token: `${token}.x`, now })).toBe('INVALID');
  });
});

describe('public form verified proof', () => {
  const proof = createPublicFormVerifiedProof({ key: KEY, formId: 'form-1', email: 'Ann@Example.com', now });

  it('is valid for the same form and address in any letter case', () => {
    expect(isPublicFormVerifiedProofValid({ key: KEY, formId: 'form-1', email: 'ann@example.com', proof, now })).toBe(
      true,
    );
  });

  it('is not valid for another address or another form', () => {
    expect(isPublicFormVerifiedProofValid({ key: KEY, formId: 'form-1', email: 'bob@example.com', proof, now })).toBe(
      false,
    );
    expect(isPublicFormVerifiedProofValid({ key: KEY, formId: 'form-2', email: 'ann@example.com', proof, now })).toBe(
      false,
    );
  });

  // Solid Ten Sign (AUD-C6): one proof, one document. A re-encoded proof would hash to a new
  // one-use key, so only the exact form the server issued is valid.
  it('is not valid with leading zeros on its time', () => {
    for (const padded of [`0${proof}`, `00${proof}`]) {
      expect(
        isPublicFormVerifiedProofValid({ key: KEY, formId: 'form-1', email: 'ann@example.com', proof: padded, now }),
      ).toBe(false);
    }
  });

  it('expires', () => {
    const tooLate = at(PUBLIC_FORM_VERIFIED_PROOF_MAX_AGE_MS + 1);

    expect(
      isPublicFormVerifiedProofValid({ key: KEY, formId: 'form-1', email: 'ann@example.com', proof, now: tooLate }),
    ).toBe(false);
  });
});

describe('public form code', () => {
  const options = { key: KEY, formId: 'form-1', email: 'ann@example.com' };

  it('is six digits and accepted in its own and the next period', async () => {
    const code = await generatePublicFormCode({ ...options, now });

    expect(code).toMatch(/^\d{6}$/);
    expect(await isPublicFormCodeValid({ ...options, code, now })).toBe(true);
    expect(await isPublicFormCodeValid({ ...options, code, now: at(PUBLIC_FORM_CODE_PERIOD_MS) })).toBe(true);
  });

  it('is refused two periods later', async () => {
    const code = await generatePublicFormCode({ ...options, now });

    expect(await isPublicFormCodeValid({ ...options, code, now: at(2 * PUBLIC_FORM_CODE_PERIOD_MS) })).toBe(false);
  });

  it('only works for the address and form it was sent for', async () => {
    const code = await generatePublicFormCode({ ...options, now });

    expect(await isPublicFormCodeValid({ ...options, email: 'bob@example.com', code, now })).toBe(false);
    expect(await isPublicFormCodeValid({ ...options, formId: 'form-2', code, now })).toBe(false);
  });

  it('refuses input that is not six digits', async () => {
    expect(await isPublicFormCodeValid({ ...options, code: '12345', now })).toBe(false);
    expect(await isPublicFormCodeValid({ ...options, code: '1234567', now })).toBe(false);
  });
});

describe('unverified form blocker', () => {
  it('allows a form whose only recipient is the person filling it in', () => {
    expect(getUnverifiedFormBlocker({ recipientIds: [1], directRecipientId: 1, allowDictateNextSigner: false })).toBe(
      null,
    );
  });

  it('blocks when another recipient or a CC would get email', () => {
    expect(
      getUnverifiedFormBlocker({ recipientIds: [1, 2], directRecipientId: 1, allowDictateNextSigner: false }),
    ).toBe('OTHER_RECIPIENTS');
  });

  it('blocks when the person filling it in may choose the next signer', () => {
    expect(getUnverifiedFormBlocker({ recipientIds: [1], directRecipientId: 1, allowDictateNextSigner: true })).toBe(
      'NEXT_SIGNER_DICTATION',
    );
  });
});
