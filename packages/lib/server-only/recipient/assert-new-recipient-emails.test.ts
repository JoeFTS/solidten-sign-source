import { describe, expect, it } from 'vitest';

import { assertNewRecipientEmailsAvailable } from './assert-new-recipient-emails';

const pending = { type: 'DOCUMENT', status: 'PENDING' } as const;
const existing = [
  { id: 1, email: 'ann@example.com' },
  { id: 2, email: 'bob@example.com' },
];

describe('assertNewRecipientEmailsAvailable', () => {
  it('refuses a new recipient with an email already on a sent document', () => {
    expect(() =>
      assertNewRecipientEmailsAvailable({
        envelope: pending,
        existingIds: [1, 2],
        resulting: [...existing, { email: 'ANN@example.com ' }],
      }),
    ).toThrow('already a recipient');
  });

  it('refuses two new recipients with the same email', () => {
    expect(() =>
      assertNewRecipientEmailsAvailable({
        envelope: pending,
        existingIds: [1, 2],
        resulting: [...existing, { email: 'cy@example.com' }, { email: 'cy@example.com' }],
      }),
    ).toThrow('already a recipient');
  });

  it('allows a new, different email, and leaves existing rows alone', () => {
    expect(() =>
      assertNewRecipientEmailsAvailable({
        envelope: pending,
        existingIds: [1, 2],
        resulting: [...existing, { email: 'cy@example.com' }],
      }),
    ).not.toThrow();
  });

  it('keeps upstream behaviour on drafts', () => {
    expect(() =>
      assertNewRecipientEmailsAvailable({
        envelope: { type: 'DOCUMENT', status: 'DRAFT' },
        existingIds: [1, 2],
        resulting: [...existing, { email: 'ann@example.com' }],
      }),
    ).not.toThrow();
  });
});
