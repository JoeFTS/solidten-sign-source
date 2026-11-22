import { recordDatabaseWriteFailure } from '../server-only/health/database-write-health';
import { AppError, AppErrorCode } from './app-error';
import { isDatabaseUnavailableError, isRawDatabaseError } from './database-error-kind';

export { isDatabaseUnavailableError, isRawDatabaseError };

/**
 * Solid Ten: database errors never reach a caller with their internals (DISK-L1).
 *
 * On a full database disk, creates and field signs answered 500 with Prisma's text: the query,
 * Postgres file paths, SQLSTATE 53100. Two answers replace that:
 * - the database cannot take the request now (disk or memory full, too many connections, the
 *   server unreachable, restarting or shutting down): 503 DATABASE_UNAVAILABLE "Temporarily
 *   unable to save. Try again in a few minutes." with Retry-After;
 * - any other database error: 500 with "Something went wrong. Try again."
 * The original error is logged for operators.
 */
export const DATABASE_UNAVAILABLE_CODE = 'DATABASE_UNAVAILABLE';
export const DATABASE_UNAVAILABLE_MESSAGE = 'Temporarily unable to save. Try again in a few minutes.';
export const DATABASE_UNAVAILABLE_RETRY_AFTER_SECONDS = 30;
export const DATABASE_ERROR_MESSAGE = 'Something went wrong. Try again.';

export const createDatabaseUnavailableError = () =>
  new AppError(DATABASE_UNAVAILABLE_CODE, {
    message: DATABASE_UNAVAILABLE_MESSAGE,
    userMessage: DATABASE_UNAVAILABLE_MESSAGE,
    statusCode: 503,
    headers: { 'Retry-After': String(DATABASE_UNAVAILABLE_RETRY_AFTER_SECONDS) },
  });

export const createDatabaseError = () =>
  new AppError(AppErrorCode.UNKNOWN_ERROR, {
    message: DATABASE_ERROR_MESSAGE,
    userMessage: DATABASE_ERROR_MESSAGE,
    statusCode: 500,
  });

/**
 * The answer a caller may see for a database error, or null when `error` is not one. Logs the
 * original. Transaction timeouts are answered as SERVER_BUSY before this (server-busy.ts).
 */
export const toPublicDatabaseError = (error: unknown, where = 'request'): AppError | null => {
  if (isDatabaseUnavailableError(error)) {
    console.error(`[DATABASE]: unavailable during ${where}; answered 503`, error);
    recordDatabaseWriteFailure();

    return createDatabaseUnavailableError();
  }

  if (isRawDatabaseError(error)) {
    console.error(`[DATABASE]: error during ${where}; answered 500 without details`, error);

    return createDatabaseError();
  }

  return null;
};
