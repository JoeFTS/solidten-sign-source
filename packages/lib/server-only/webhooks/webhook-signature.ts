import { createHmac, timingSafeEqual } from 'node:crypto';

export const WEBHOOK_SIGNATURE_HEADER = 'X-SolidTen-Signature';
export const WEBHOOK_TIMESTAMP_HEADER = 'X-SolidTen-Timestamp';

/** Receivers should refuse deliveries older (or newer) than this. Five minutes allows for clock drift. */
export const WEBHOOK_SIGNATURE_TOLERANCE_SECONDS = 300;

const SIGNATURE_VERSION = 'v1';

/**
 * HMAC-SHA256 over `${timestamp}.${body}` with the webhook secret, hex encoded, prefixed "v1=".
 * The timestamp is inside the signed text, so a receiver that checks its age also stops replays.
 */
export const signWebhookBody = ({ secret, timestamp, body }: { secret: string; timestamp: number; body: string }) =>
  `${SIGNATURE_VERSION}=${createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex')}`;

export const buildWebhookSignatureHeaders = ({
  secret,
  body,
  now = new Date(),
}: {
  secret: string | null;
  body: string;
  now?: Date;
}): Record<string, string> => {
  if (!secret) {
    return {};
  }

  const timestamp = Math.floor(now.getTime() / 1000);

  return {
    [WEBHOOK_TIMESTAMP_HEADER]: String(timestamp),
    [WEBHOOK_SIGNATURE_HEADER]: signWebhookBody({ secret, timestamp, body }),
  };
};

export type TVerifyWebhookSignatureResult =
  | { valid: true }
  | { valid: false; reason: 'MISSING_HEADERS' | 'MALFORMED' | 'EXPIRED' | 'MISMATCH' };

/**
 * Reference verifier. The docs carry a standalone copy for receivers; keep the two in step.
 */
export const verifyWebhookSignature = ({
  secret,
  body,
  timestampHeader,
  signatureHeader,
  now = new Date(),
  toleranceSeconds = WEBHOOK_SIGNATURE_TOLERANCE_SECONDS,
}: {
  secret: string;
  body: string;
  timestampHeader: string | null | undefined;
  signatureHeader: string | null | undefined;
  now?: Date;
  toleranceSeconds?: number;
}): TVerifyWebhookSignatureResult => {
  if (!timestampHeader || !signatureHeader) {
    return { valid: false, reason: 'MISSING_HEADERS' };
  }

  if (!/^\d{1,12}$/.test(timestampHeader) || !/^v1=[0-9a-f]{64}$/.test(signatureHeader)) {
    return { valid: false, reason: 'MALFORMED' };
  }

  const timestamp = Number(timestampHeader);

  if (Math.abs(Math.floor(now.getTime() / 1000) - timestamp) > toleranceSeconds) {
    return { valid: false, reason: 'EXPIRED' };
  }

  const expected = Buffer.from(signWebhookBody({ secret, timestamp, body }));
  const received = Buffer.from(signatureHeader);

  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    return { valid: false, reason: 'MISMATCH' };
  }

  return { valid: true };
};
