import { describe, expect, it } from 'vitest';

import { findPublicFormCodeCounter, generatePublicFormCode, PUBLIC_FORM_CODE_PERIOD_MS } from './public-form';

const key = 'test-key';
const formId = 'form_1';
const email = 'ann@example.com';

describe('findPublicFormCodeCounter', () => {
  it('returns the time step of a valid code, also from the previous step', async () => {
    const now = new Date(1_800_000_000_000);
    const counter = Math.floor(now.getTime() / PUBLIC_FORM_CODE_PERIOD_MS);

    const current = await generatePublicFormCode({ key, formId, email, now });
    expect(await findPublicFormCodeCounter({ key, formId, email, code: current, now })).toBe(counter);

    const later = new Date(now.getTime() + PUBLIC_FORM_CODE_PERIOD_MS);
    expect(await findPublicFormCodeCounter({ key, formId, email, code: current, now: later })).toBe(counter);
  });

  it('returns null for a wrong or malformed code', async () => {
    const now = new Date(1_800_000_000_000);

    expect(await findPublicFormCodeCounter({ key, formId, email, code: '12345', now })).toBeNull();
    expect(await findPublicFormCodeCounter({ key, formId: 'other', email, code: '000000', now })).toBeNull();
  });
});

describe('code generations (RT4-M3)', () => {
  it('gives a different code for the next generation in the same step, which verifies only there', async () => {
    const now = new Date(1_800_000_000_000);

    const first = await generatePublicFormCode({ key, formId, email, now, generation: 0 });
    const second = await generatePublicFormCode({ key, formId, email, now, generation: 1 });

    expect(second).not.toBe(first);
    expect(await findPublicFormCodeCounter({ key, formId, email, code: second, now, generation: 1 })).not.toBeNull();
    expect(await findPublicFormCodeCounter({ key, formId, email, code: first, now, generation: 1 })).toBeNull();
  });
});
