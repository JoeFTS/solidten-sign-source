import { env } from '../../../utils/env';
import type { TSmsProvider, TSmsSendResult } from './types';

const TWILIO_API_BASE = 'https://api.twilio.com/2010-04-01';

const SEND_TIMEOUT_MS = 10_000;

// https://www.twilio.com/docs/api/errors
const TWILIO_OPTED_OUT_CODES = new Set([21610]);
const TWILIO_INVALID_NUMBER_CODES = new Set([21211, 21214, 21217, 21219, 21401, 21407, 21408, 21612, 21614]);

type TTwilioConfig = {
  accountSid: string;
  authToken: string;
  fromNumber?: string;
  messagingServiceSid?: string;
};

export const getTwilioConfig = (): TTwilioConfig | null => {
  const accountSid = env('NEXT_PRIVATE_TWILIO_ACCOUNT_SID');
  const authToken = env('NEXT_PRIVATE_TWILIO_AUTH_TOKEN');
  const fromNumber = env('NEXT_PRIVATE_TWILIO_FROM_NUMBER') || undefined;
  const messagingServiceSid = env('NEXT_PRIVATE_TWILIO_MESSAGING_SERVICE_SID') || undefined;

  if (!accountSid || !authToken || (!fromNumber && !messagingServiceSid)) {
    return null;
  }

  return { accountSid, authToken, fromNumber, messagingServiceSid };
};

/**
 * Map a Twilio error response to our result. Exported for unit tests.
 */
export const mapTwilioError = (httpStatus: number, body: unknown): TSmsSendResult & { success: false } => {
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const code = typeof record.code === 'number' ? record.code : null;
  const message = typeof record.message === 'string' ? record.message : `Twilio returned HTTP ${httpStatus}`;

  if (code !== null && TWILIO_OPTED_OUT_CODES.has(code)) {
    return { success: false, reason: 'OPTED_OUT', errorCode: String(code), message, isRetryable: false };
  }

  if (code !== null && TWILIO_INVALID_NUMBER_CODES.has(code)) {
    return { success: false, reason: 'INVALID_NUMBER', errorCode: String(code), message, isRetryable: false };
  }

  return {
    success: false,
    reason: 'PROVIDER_ERROR',
    errorCode: code !== null ? String(code) : `HTTP_${httpStatus}`,
    message,
    isRetryable: httpStatus === 429 || httpStatus >= 500,
  };
};

export const createTwilioSmsProvider = (config: TTwilioConfig): TSmsProvider => ({
  name: 'twilio',
  send: async ({ toE164, body }) => {
    const form = new URLSearchParams({ To: toE164, Body: body });

    if (config.messagingServiceSid) {
      form.set('MessagingServiceSid', config.messagingServiceSid);
    } else if (config.fromNumber) {
      form.set('From', config.fromNumber);
    }

    const credentials = Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64');

    let response: Response;

    try {
      response = await fetch(`${TWILIO_API_BASE}/Accounts/${encodeURIComponent(config.accountSid)}/Messages.json`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: form.toString(),
        redirect: 'error',
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch (err) {
      const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');

      return {
        success: false,
        reason: isTimeout ? 'TIMEOUT' : 'PROVIDER_ERROR',
        errorCode: isTimeout ? 'TIMEOUT' : 'NETWORK',
        message: err instanceof Error ? err.message : 'Network error',
        isRetryable: true,
      };
    }

    const json: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      return mapTwilioError(response.status, json);
    }

    const sid =
      typeof json === 'object' && json !== null && typeof (json as Record<string, unknown>).sid === 'string'
        ? String((json as Record<string, unknown>).sid)
        : null;

    return { success: true, providerMessageId: sid };
  },
});
