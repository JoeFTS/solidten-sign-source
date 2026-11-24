import { RecipientRole, SigningStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { assertRecipientChangeAllowed, keepsRecipientStatus } from './assert-recipient-change-allowed';

const ann = {
  id: 1,
  name: 'Ann Lee',
  email: 'ann@example.com',
  role: RecipientRole.SIGNER,
  signingStatus: SigningStatus.SIGNED,
};

describe('R-1: assertRecipientChangeAllowed', () => {
  it('refuses removing a recipient who signed, naming them', () => {
    expect(() => assertRecipientChangeAllowed(ann, 'remove')).toThrow(
      'Ann Lee (ann@example.com) has already signed and cannot be removed.',
    );
  });

  it('refuses a new email or role, allows the same values', () => {
    expect(() => assertRecipientChangeAllowed(ann, { email: 'other@example.com' })).toThrow(
      'so their email and role cannot be changed',
    );
    expect(() => assertRecipientChangeAllowed(ann, { role: RecipientRole.APPROVER })).toThrow();
    expect(() =>
      assertRecipientChangeAllowed(ann, { email: 'ANN@example.com', role: RecipientRole.SIGNER }),
    ).not.toThrow();
  });

  it('uses the role verb; a CC and an unsigned recipient are not blocked', () => {
    expect(() => assertRecipientChangeAllowed({ ...ann, role: RecipientRole.APPROVER }, 'remove')).toThrow(
      'has already approved',
    );
    expect(() => assertRecipientChangeAllowed({ ...ann, role: RecipientRole.CC }, 'remove')).not.toThrow();
    expect(() =>
      assertRecipientChangeAllowed({ ...ann, signingStatus: SigningStatus.NOT_SIGNED }, 'remove'),
    ).not.toThrow();
  });
});

describe('R-3: keepsRecipientStatus', () => {
  const base = { email: 'ben@example.com', role: RecipientRole.SIGNER };

  it('keeps between linked roles and on no change; resets on a new email or to/from CC', () => {
    expect(keepsRecipientStatus(base, base)).toBe(true);
    expect(keepsRecipientStatus(base, { ...base, role: RecipientRole.APPROVER })).toBe(true);
    expect(keepsRecipientStatus(base, { ...base, role: RecipientRole.VIEWER })).toBe(true);
    expect(keepsRecipientStatus(base, { ...base, email: 'new@example.com' })).toBe(false);
    expect(keepsRecipientStatus(base, { ...base, role: RecipientRole.CC })).toBe(false);
    expect(keepsRecipientStatus({ ...base, role: RecipientRole.CC }, base)).toBe(false);
  });
});
