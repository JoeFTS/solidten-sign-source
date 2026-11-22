import { env } from '../../utils/env';
import { createFakeSmsProvider } from './providers/fake';
import { createTwilioSmsProvider, getTwilioConfig } from './providers/twilio';
import type { TSmsProvider } from './providers/types';

export type TSmsProviderName = 'twilio' | 'fake';

export const getConfiguredSmsProviderName = (): TSmsProviderName | null => {
  const value = env('NEXT_PRIVATE_SMS_PROVIDER');

  if (value === 'twilio') {
    return value;
  }

  // Solid Ten Sign: the fake provider writes texts to a table instead of sending them. In
  // production it is refused unless NEXT_PRIVATE_ST_SMS_ALLOW_FAKE_IN_PRODUCTION=true, so a
  // test setting cannot silently swallow every signing text.
  if (value === 'fake') {
    return isFakeSmsProviderAllowed() ? value : null;
  }

  return null;
};

export const isFakeSmsProviderAllowed = (
  nodeEnv: string | undefined = process.env.NODE_ENV,
  allowInProduction: string | undefined = env('NEXT_PRIVATE_ST_SMS_ALLOW_FAKE_IN_PRODUCTION'),
) => nodeEnv !== 'production' || allowInProduction === 'true';

/**
 * Whether text messages can be sent on this server at all. When false the feature is hidden
 * everywhere and no code path sends a text.
 */
export const isSmsProviderConfigured = () => {
  const name = getConfiguredSmsProviderName();

  if (name === 'twilio') {
    return getTwilioConfig() !== null;
  }

  return name === 'fake';
};

export const getSmsProvider = (): TSmsProvider | null => {
  const name = getConfiguredSmsProviderName();

  if (name === 'fake') {
    return createFakeSmsProvider();
  }

  if (name === 'twilio') {
    const config = getTwilioConfig();

    return config ? createTwilioSmsProvider(config) : null;
  }

  return null;
};
