import { DocumentSigningOrder, DocumentStatus, RecipientRole, SigningStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import {
  getInPersonEnvelopeBlockReason,
  getInPersonSignerBlockReason,
  getInPersonTurnRecipients,
  isInPersonNameConfirmed,
  isValidInPersonPin,
} from './in-person';

const envelope = {
  status: DocumentStatus.PENDING,
  internalVersion: 2,
  deletedAt: null,
  signatureLevel: 'SES',
} as const;

describe('getInPersonEnvelopeBlockReason', () => {
  it('allows a pending version-2 envelope', () => {
    expect(getInPersonEnvelopeBlockReason({ envelope, allowInPersonSigning: true })).toBeNull();
  });

  it('refuses when the setting is off, and on legacy, qualified, deleted and finished envelopes', () => {
    expect(getInPersonEnvelopeBlockReason({ envelope, allowInPersonSigning: false })).toBe('NOT_ALLOWED_BY_SETTINGS');
    expect(
      getInPersonEnvelopeBlockReason({ envelope: { ...envelope, internalVersion: 1 }, allowInPersonSigning: true }),
    ).toBe('VERSION_1');
    expect(
      getInPersonEnvelopeBlockReason({ envelope: { ...envelope, signatureLevel: 'QES' }, allowInPersonSigning: true }),
    ).toBe('TSP');
    expect(
      getInPersonEnvelopeBlockReason({ envelope: { ...envelope, deletedAt: new Date() }, allowInPersonSigning: true }),
    ).toBe('DELETED');
    expect(
      getInPersonEnvelopeBlockReason({
        envelope: { ...envelope, status: DocumentStatus.COMPLETED },
        allowInPersonSigning: true,
      }),
    ).toBe('NOT_PENDING');
  });
});

describe('getInPersonSignerBlockReason', () => {
  const recipient = { email: 'signer@example.com', expiresAt: null };

  it('allows a signer with no checks or an email-code access check', () => {
    expect(
      getInPersonSignerBlockReason({ recipient, accessAuth: [], actionAuth: [], hostEmail: 'host@example.com' }),
    ).toBeNull();
    expect(
      getInPersonSignerBlockReason({
        recipient,
        accessAuth: ['TWO_FACTOR_AUTH'],
        actionAuth: ['EXPLICIT_NONE'],
        hostEmail: 'host@example.com',
      }),
    ).toBeNull();
  });

  it('refuses checks that need the signer account', () => {
    for (const actionAuth of ['ACCOUNT', 'PASSKEY', 'TWO_FACTOR_AUTH', 'PASSWORD'] as const) {
      expect(
        getInPersonSignerBlockReason({
          recipient,
          accessAuth: [],
          actionAuth: [actionAuth],
          hostEmail: 'host@example.com',
        }),
      ).toBe('ACCOUNT_REQUIRED');
    }

    expect(
      getInPersonSignerBlockReason({
        recipient,
        accessAuth: ['ACCOUNT'],
        actionAuth: [],
        hostEmail: 'host@example.com',
      }),
    ).toBe('ACCOUNT_REQUIRED');
  });

  it('refuses the host as a signer and expired signers', () => {
    expect(
      getInPersonSignerBlockReason({ recipient, accessAuth: [], actionAuth: [], hostEmail: 'Signer@Example.com' }),
    ).toBe('HOST_IS_RECIPIENT');
    expect(
      getInPersonSignerBlockReason({
        recipient: { ...recipient, expiresAt: new Date(Date.now() - 1000) },
        accessAuth: [],
        actionAuth: [],
        hostEmail: 'host@example.com',
      }),
    ).toBe('EXPIRED');
  });
});

describe('getInPersonTurnRecipients', () => {
  const make = (id: number, signingOrder: number | null, signingStatus: SigningStatus = SigningStatus.NOT_SIGNED) => ({
    id,
    role: RecipientRole.SIGNER,
    signingStatus,
    signingOrder,
  });

  it('returns every pending non-CC recipient for parallel signing', () => {
    const recipients = [
      make(1, 1),
      make(2, 2, SigningStatus.SIGNED),
      { ...make(3, 3), role: RecipientRole.CC },
      make(4, 4),
    ];

    expect(getInPersonTurnRecipients(recipients, DocumentSigningOrder.PARALLEL).map((r) => r.id)).toEqual([1, 4]);
  });

  it('returns only the active step for sequential signing', () => {
    expect(
      getInPersonTurnRecipients([make(1, 1), make(2, 2)], DocumentSigningOrder.SEQUENTIAL).map((r) => r.id),
    ).toEqual([1]);

    expect(
      getInPersonTurnRecipients(
        [make(1, 1, SigningStatus.SIGNED), make(2, 2), make(3, 2), make(4, 3)],
        DocumentSigningOrder.SEQUENTIAL,
      ).map((r) => r.id),
    ).toEqual([2, 3]);
  });

  it('does not offer a recipient who declined', () => {
    expect(
      getInPersonTurnRecipients([make(1, 1, SigningStatus.REJECTED), make(2, 2)], DocumentSigningOrder.PARALLEL).map(
        (r) => r.id,
      ),
    ).toEqual([2]);
  });
});

describe('isInPersonNameConfirmed', () => {
  it('matches ignoring case and spacing', () => {
    expect(isInPersonNameConfirmed({ expected: 'Ada Lovelace', typed: '  ada   LOVELACE ' })).toBe(true);
    expect(isInPersonNameConfirmed({ expected: 'Ada Lovelace', typed: 'Ada Byron' })).toBe(false);
  });

  it('accepts any real name when the recipient has none', () => {
    expect(isInPersonNameConfirmed({ expected: '', typed: 'Ada' })).toBe(true);
    expect(isInPersonNameConfirmed({ expected: '', typed: ' a ' })).toBe(false);
  });
});

describe('isValidInPersonPin', () => {
  it('takes 4 to 8 digits only', () => {
    expect(isValidInPersonPin('1234')).toBe(true);
    expect(isValidInPersonPin('12345678')).toBe(true);
    expect(isValidInPersonPin('123')).toBe(false);
    expect(isValidInPersonPin('12a4')).toBe(false);
    expect(isValidInPersonPin('123456789')).toBe(false);
  });
});
