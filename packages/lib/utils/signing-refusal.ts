import { AppErrorCode } from '../errors/app-error';
import { SERVER_BUSY_CODE } from '../errors/server-busy';

export type SigningRefusal = {
  kind: 'refused' | 'busy' | 'rateLimited';
  /**
   * The text to show: the server's own reason, or a fixed one for busy and rate-limited.
   */
  message: string;
};

// Refusals whose server message is written for the person signing or filling in a form.
const REFUSAL_CODES: string[] = [
  AppErrorCode.INVALID_BODY,
  AppErrorCode.INVALID_REQUEST,
  AppErrorCode.LIMIT_EXCEEDED,
  AppErrorCode.MISSING_SIGNATURE_FIELD,
  'RECIPIENT_LIMIT_EXCEEDED',
];

const BUSY_MESSAGE = 'The server is busy. Please try again in a moment.';
const RATE_LIMITED_MESSAGE = 'Too many attempts. Please wait a moment and try again.';

/**
 * Sort a refused signing or form submission into an expected refusal (show the server's
 * reason) or an unexpected error (null: show the generic text). Codes with their own fixed
 * text on the signing page (not found, out of turn, expired, completed, ...) are not
 * handled here.
 *
 * `httpStatus` covers refusals that never reached the handler, such as the rate limiter.
 */
export const describeSigningRefusal = ({
  code,
  message,
  httpStatus,
}: {
  code: string;
  message?: string | null;
  httpStatus?: number | null;
}): SigningRefusal | null => {
  const text = message?.trim() ?? '';

  if (code === SERVER_BUSY_CODE || httpStatus === 503) {
    return { kind: 'busy', message: BUSY_MESSAGE };
  }

  if (code === AppErrorCode.TOO_MANY_REQUESTS || httpStatus === 429) {
    // The daily cap of code emails has its own reason ("... try again tomorrow").
    const isOwnReason = code === AppErrorCode.TOO_MANY_REQUESTS && /tomorrow|minutes/i.test(text);

    return { kind: 'rateLimited', message: isOwnReason ? text : RATE_LIMITED_MESSAGE };
  }

  if (!text) {
    return null;
  }

  if (code.startsWith('PUBLIC_FORM_') || REFUSAL_CODES.includes(code)) {
    return { kind: 'refused', message: text };
  }

  return null;
};
