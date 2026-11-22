import { megabytesToBytes } from '../../universal/unit-convertions';
import { env } from '../../utils/env';

/**
 * Solid Ten: emails that carry the signed document attach it only up to a size.
 *
 * Mail providers refuse large messages (one we plan to use allows 10 MB per message, and an
 * attachment grows to about 1.4 times the file). Above the limit, summed over all files of the
 * envelope, the email is sent without attachments and with a download link instead. A provider
 * that still refuses a message as too large gets the link version once, instead of the job
 * retrying the same message.
 */
export const DEFAULT_EMAIL_ATTACHMENT_LIMIT_MB = 7;

export type TDocumentDelivery = 'ATTACHMENT' | 'LINK';

export const getEmailAttachmentLimitBytes = () => {
  const value = Number(env('NEXT_PRIVATE_ST_EMAIL_ATTACHMENT_LIMIT_MB'));

  return megabytesToBytes(Number.isFinite(value) && value > 0 ? value : DEFAULT_EMAIL_ATTACHMENT_LIMIT_MB);
};

export const getTotalAttachmentBytes = (attachments: Array<{ content: Buffer | Uint8Array }>) =>
  attachments.reduce((total, attachment) => total + attachment.content.byteLength, 0);

/**
 * Decide from the stored size, before anything is loaded (LD2-B). An unknown size (null) is
 * treated as too large.
 */
export const getDocumentDeliveryForBytes = (
  totalBytes: number | null,
  limitBytes = getEmailAttachmentLimitBytes(),
): TDocumentDelivery => (totalBytes !== null && totalBytes <= limitBytes ? 'ATTACHMENT' : 'LINK');

export const getDocumentDelivery = (
  attachments: Array<{ content: Buffer | Uint8Array }>,
  limitBytes = getEmailAttachmentLimitBytes(),
): TDocumentDelivery => (getTotalAttachmentBytes(attachments) <= limitBytes ? 'ATTACHMENT' : 'LINK');

/**
 * True for an SMTP refusal because of the message size: 552 ("exceeded storage allocation",
 * used for size), 523, or a 5xx reply that names the size.
 */
export const isMessageTooLargeError = (error: unknown) => {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const { responseCode, response, message } = error as {
    responseCode?: number;
    response?: string;
    message?: string;
  };

  if (responseCode === 552 || responseCode === 523) {
    return true;
  }

  const text = `${response ?? ''} ${message ?? ''}`;
  const isPermanent = responseCode === undefined || (responseCode >= 500 && responseCode < 600);

  return isPermanent && /(message|mail)?\s*(size|too (large|big)|exceeds? .*(size|limit))/i.test(text);
};

/**
 * Send in the planned form (from getDocumentDeliveryForBytes). When the attached version is
 * refused as too large, send the link version once. Returns the form that was sent.
 */
export const sendWithDocumentDeliveryFallback = async (
  delivery: TDocumentDelivery,
  send: (delivery: TDocumentDelivery) => Promise<void>,
): Promise<TDocumentDelivery> => {
  try {
    await send(delivery);

    return delivery;
  } catch (error) {
    if (delivery === 'ATTACHMENT' && isMessageTooLargeError(error)) {
      console.warn('[EMAIL]: The mail server refused the message as too large; sending a download link instead');

      await send('LINK');

      return 'LINK';
    }

    throw error;
  }
};
