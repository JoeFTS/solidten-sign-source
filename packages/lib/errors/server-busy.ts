import { AppError } from './app-error';

/**
 * Solid Ten: "the server is busy" (LD2-A). The heavy-PDF queue refuses with it when it is full,
 * and a database transaction that ran out of time is reported with it instead of a 500 that
 * carries Prisma's text. HTTP 503 with Retry-After.
 */
export const SERVER_BUSY_CODE = 'SERVER_BUSY';
export const SERVER_BUSY_MESSAGE = 'The server is busy, try again.';
export const SERVER_BUSY_RETRY_AFTER_SECONDS = 15;

export const createServerBusyError = (retryAfterSeconds = SERVER_BUSY_RETRY_AFTER_SECONDS) =>
  new AppError(SERVER_BUSY_CODE, {
    message: SERVER_BUSY_MESSAGE,
    userMessage: SERVER_BUSY_MESSAGE,
    statusCode: 503,
    headers: { 'Retry-After': String(retryAfterSeconds) },
  });

/**
 * True for an interactive transaction that ran out of time or could not start in time:
 * Prisma P2028 ("Transaction API error", "Transaction already closed ... timeout") and the
 * same text when the code is missing.
 */
export const isTransactionTimeoutError = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const { code, message } = error as { code?: unknown; message?: unknown };

  if (code === 'P2028') {
    return true;
  }

  return (
    typeof message === 'string' &&
    /Transaction already closed|Transaction API error|Unable to start a transaction in the given time|expired transaction/i.test(
      message,
    )
  );
};
