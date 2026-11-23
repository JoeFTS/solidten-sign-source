import { AppError } from '../errors/app-error';
import { readDirectLinkSignatureRefusal } from '../errors/direct-link-signature-error';

/**
 * Solid Ten Sign (P-5): the reason a row failed, in words the sender can act on. The job runner
 * wraps errors ("Task failed"); the cause holds the refusal, whose message is plain (N-3).
 */
export const describeBulkRowFailure = (error: unknown): string => {
  const directLinkRefusal = readDirectLinkSignatureRefusal(error);

  if (directLinkRefusal) {
    return directLinkRefusal;
  }

  let current: unknown = error;

  for (let depth = 0; depth < 5 && current; depth++) {
    if (current instanceof AppError) {
      if (current.code === 'DOCUMENT_SEND_FAILED') {
        return 'The document was created but could not be sent. Open it and send it again.';
      }

      if (current.message && current.message !== current.code) {
        return current.message;
      }
    }

    current = (current as { cause?: unknown }).cause;
  }

  return 'Something went wrong. Try again.';
};
