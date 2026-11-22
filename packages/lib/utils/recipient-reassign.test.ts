import { DocumentStatus, RecipientRole, SigningStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { getRecipientReassignBlockReason, isReassignEmailTaken } from './recipient-reassign';

const now = new Date('2026-06-01T12:00:00.000Z');

const base = {
  actor: 'SIGNER' as const,
  envelope: { status: DocumentStatus.PENDING, internalVersion: 2, signatureLevel: 'SES' },
  recipient: { role: RecipientRole.SIGNER, signingStatus: SigningStatus.NOT_SIGNED, expiresAt: null },
  settings: { allowSenderReassign: true, allowSignerReassign: true },
  accessAuthMethods: [],
  now,
};

describe('getRecipientReassignBlockReason', () => {
  it('allows a pending signer who has not acted', () => {
    expect(getRecipientReassignBlockReason(base)).toBeNull();
  });

  it('refuses legacy, qualified-signature and non-pending envelopes', () => {
    expect(getRecipientReassignBlockReason({ ...base, envelope: { ...base.envelope, internalVersion: 1 } })).toBe(
      'ENVELOPE_LEGACY',
    );

    expect(getRecipientReassignBlockReason({ ...base, envelope: { ...base.envelope, signatureLevel: 'QES' } })).toBe(
      'ENVELOPE_TSP',
    );

    expect(
      getRecipientReassignBlockReason({ ...base, envelope: { ...base.envelope, status: DocumentStatus.COMPLETED } }),
    ).toBe('ENVELOPE_NOT_PENDING');

    expect(
      getRecipientReassignBlockReason({ ...base, envelope: { ...base.envelope, status: DocumentStatus.DRAFT } }),
    ).toBe('ENVELOPE_NOT_PENDING');
  });

  it('refuses a recipient who signed or rejected, and copy recipients', () => {
    expect(
      getRecipientReassignBlockReason({
        ...base,
        recipient: { ...base.recipient, signingStatus: SigningStatus.SIGNED },
      }),
    ).toBe('RECIPIENT_ALREADY_ACTED');

    expect(
      getRecipientReassignBlockReason({
        ...base,
        recipient: { ...base.recipient, signingStatus: SigningStatus.REJECTED },
      }),
    ).toBe('RECIPIENT_ALREADY_ACTED');

    expect(getRecipientReassignBlockReason({ ...base, recipient: { ...base.recipient, role: RecipientRole.CC } })).toBe(
      'RECIPIENT_IS_CC',
    );
  });

  it('applies the setting for the actor', () => {
    const settings = { allowSenderReassign: true, allowSignerReassign: false };

    expect(getRecipientReassignBlockReason({ ...base, settings })).toBe('NOT_ALLOWED_BY_SETTINGS');
    expect(getRecipientReassignBlockReason({ ...base, settings, actor: 'SENDER' })).toBeNull();

    expect(
      getRecipientReassignBlockReason({
        ...base,
        actor: 'SENDER',
        settings: { allowSenderReassign: false, allowSignerReassign: true },
      }),
    ).toBe('NOT_ALLOWED_BY_SETTINGS');
  });

  it('refuses an expired link for the signer but lets the sender reassign it', () => {
    const recipient = { ...base.recipient, expiresAt: new Date(now.getTime() - 1) };

    expect(getRecipientReassignBlockReason({ ...base, recipient })).toBe('RECIPIENT_EXPIRED');
    expect(getRecipientReassignBlockReason({ ...base, recipient, actor: 'SENDER' })).toBeNull();
  });

  it('lets a signer behind an account check reassign, but not one behind a 2FA check', () => {
    expect(getRecipientReassignBlockReason({ ...base, accessAuthMethods: ['ACCOUNT'] })).toBeNull();

    expect(getRecipientReassignBlockReason({ ...base, accessAuthMethods: ['TWO_FACTOR_AUTH'] })).toBe(
      'ACCESS_AUTH_NOT_VERIFIABLE',
    );

    expect(
      getRecipientReassignBlockReason({ ...base, accessAuthMethods: ['TWO_FACTOR_AUTH'], actor: 'SENDER' }),
    ).toBeNull();
  });
});

describe('isReassignEmailTaken', () => {
  const recipients = [{ email: 'Ada@Example.com' }, { email: 'bob@example.com' }];

  it('matches existing recipients regardless of case and spaces', () => {
    expect(isReassignEmailTaken({ recipients, newEmail: ' ada@example.COM ' })).toBe(true);
  });

  it('accepts an email nobody on the envelope has', () => {
    expect(isReassignEmailTaken({ recipients, newEmail: 'carol@example.com' })).toBe(false);
  });
});
