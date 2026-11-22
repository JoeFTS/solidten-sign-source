import { describe, expect, it } from 'vitest';

import { buildRecipientHandoverData } from '../server-only/recipient-reassign/recipient-handover';
import { canSendMailToRecipient } from './recipient-mail';

describe('canSendMailToRecipient', () => {
  it('sends to a valid address that is not marked', () => {
    expect(canSendMailToRecipient({ email: 'owner-set@example.com', unverifiedEmailAt: null })).toBe(true);
  });

  it('does not send to an address an unverified direct-link visitor typed', () => {
    expect(canSendMailToRecipient({ email: 'typed@example.com', unverifiedEmailAt: new Date() })).toBe(false);
  });

  it('does not send to an invalid address', () => {
    expect(canSendMailToRecipient({ email: 'not-an-email', unverifiedEmailAt: null })).toBe(false);
  });

  it('clears the mark when the sender changes the email', () => {
    expect(buildRecipientHandoverData({ previousExpiresAt: null, envelopeExpirationPeriod: null })).toMatchObject({
      unverifiedEmailAt: null,
    });
  });
});
