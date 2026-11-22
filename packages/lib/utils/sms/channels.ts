import { z } from 'zod';

export const ZSigningChannelSchema = z
  .enum(['EMAIL', 'SMS', 'EMAIL_AND_SMS'])
  .describe('How the signing link is delivered: by email, by text message, or both. Defaults to EMAIL.');

export type TSigningChannel = z.infer<typeof ZSigningChannelSchema>;

export const SIGNING_CHANNEL = ZSigningChannelSchema.enum;

export const parseSigningChannel = (value: string | null | undefined): TSigningChannel => {
  const parsed = ZSigningChannelSchema.safeParse(value);

  return parsed.success ? parsed.data : SIGNING_CHANNEL.EMAIL;
};

export const isSmsChannelRequested = (value: string | null | undefined) =>
  parseSigningChannel(value) !== SIGNING_CHANNEL.EMAIL;

export type TResolveRecipientChannelsOptions = {
  /** False when the envelope uses manual link sharing (distribution method NONE). */
  isDistributionEmail: boolean;
  signingChannel: string | null | undefined;
  /** The envelope's own "signing request email" setting. */
  isSigningRequestEmailEnabled: boolean;
  /** Provider configured on the server AND text messages turned on for the team. */
  isSmsAvailable: boolean;
  /** Recipient has a stored number that has not opted out. */
  canTextRecipient: boolean;
};

export type TRecipientChannels = {
  email: boolean;
  sms: boolean;
};

/**
 * Decide which channels carry the signing link for one recipient.
 *
 * When the sender chose text only but the text cannot go (feature off, no number, opted out),
 * the email goes instead, so a signer is never left without a link. Email stays the recipient's
 * identity, so this fallback is always safe.
 */
export const resolveRecipientChannels = ({
  isDistributionEmail,
  signingChannel,
  isSigningRequestEmailEnabled,
  isSmsAvailable,
  canTextRecipient,
}: TResolveRecipientChannelsOptions): TRecipientChannels => {
  if (!isDistributionEmail) {
    return { email: false, sms: false };
  }

  const channel = parseSigningChannel(signingChannel);

  const sms = channel !== SIGNING_CHANNEL.EMAIL && isSmsAvailable && canTextRecipient;

  if (channel === SIGNING_CHANNEL.SMS && sms) {
    return { email: false, sms: true };
  }

  return { email: isSigningRequestEmailEnabled, sms };
};
