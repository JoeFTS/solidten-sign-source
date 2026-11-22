import { describe, expect, it } from 'vitest';

import { parseSigningChannel, resolveRecipientChannels } from './channels';

const base = {
  isDistributionEmail: true,
  isSigningRequestEmailEnabled: true,
  isSmsAvailable: true,
  canTextRecipient: true,
};

describe('parseSigningChannel', () => {
  it('defaults unknown and empty values to EMAIL', () => {
    expect(parseSigningChannel(null)).toBe('EMAIL');
    expect(parseSigningChannel('WHATSAPP')).toBe('EMAIL');
    expect(parseSigningChannel('SMS')).toBe('SMS');
  });
});

describe('resolveRecipientChannels', () => {
  it('sends only email when the channel is EMAIL', () => {
    expect(resolveRecipientChannels({ ...base, signingChannel: 'EMAIL' })).toEqual({ email: true, sms: false });
  });

  it('sends only a text when the channel is SMS', () => {
    expect(resolveRecipientChannels({ ...base, signingChannel: 'SMS' })).toEqual({ email: false, sms: true });
  });

  it('sends both when the channel is EMAIL_AND_SMS', () => {
    expect(resolveRecipientChannels({ ...base, signingChannel: 'EMAIL_AND_SMS' })).toEqual({ email: true, sms: true });
  });

  it('texts only when email is off and the channel is EMAIL_AND_SMS', () => {
    expect(
      resolveRecipientChannels({ ...base, signingChannel: 'EMAIL_AND_SMS', isSigningRequestEmailEnabled: false }),
    ).toEqual({ email: false, sms: true });
  });

  it('falls back to email when text only is chosen but the recipient has no usable number', () => {
    expect(resolveRecipientChannels({ ...base, signingChannel: 'SMS', canTextRecipient: false })).toEqual({
      email: true,
      sms: false,
    });
  });

  it('falls back to email when text only is chosen but the team turned texts off', () => {
    expect(resolveRecipientChannels({ ...base, signingChannel: 'SMS', isSmsAvailable: false })).toEqual({
      email: true,
      sms: false,
    });
  });

  it('respects email off even in the fallback', () => {
    expect(
      resolveRecipientChannels({
        ...base,
        signingChannel: 'SMS',
        canTextRecipient: false,
        isSigningRequestEmailEnabled: false,
      }),
    ).toEqual({ email: false, sms: false });
  });

  it('sends nothing for manual link sharing', () => {
    expect(resolveRecipientChannels({ ...base, signingChannel: 'SMS', isDistributionEmail: false })).toEqual({
      email: false,
      sms: false,
    });
  });
});
