import { recordDatabaseWriteFailure } from '../server-only/health/database-write-health';
import { AppError, AppErrorCode } from './app-error';
import { isDatabaseUnavailableError, isMissingRecordError, isRawDatabaseError } from './database-error-kind';
import { readDirectLinkSignatureRefusal } from './direct-link-signature-error';

export { isDatabaseUnavailableError, isMissingRecordError, isRawDatabaseError };

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

/** Solid Ten Sign (L-3): the row a request needs was deleted (often a moment before). */
export const RECORD_NOT_FOUND_MESSAGE = 'Not found. It may have been deleted.';

export const createRecordNotFoundError = () =>
  new AppError(AppErrorCode.NOT_FOUND, {
    message: RECORD_NOT_FOUND_MESSAGE,
    userMessage: RECORD_NOT_FOUND_MESSAGE,
    statusCode: 404,
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
  // Solid Ten Sign (O-F1): the database refused a field change that would break a direct link
  // that is on. A 400 with the plain reason, not a 500.
  const directLinkRefusal = readDirectLinkSignatureRefusal(error);

  if (directLinkRefusal) {
    return new AppError(AppErrorCode.MISSING_SIGNATURE_FIELD, { message: directLinkRefusal, statusCode: 400 });
  }

  if (isDatabaseUnavailableError(error)) {
    console.error(`[DATABASE]: unavailable during ${where}; answered 503`, error);
    recordDatabaseWriteFailure();

    return createDatabaseUnavailableError();
  }

  // Solid Ten Sign (L-3): a missing row is a 404, not a 500 (a deleted draft, a deleted field).
  if (isMissingRecordError(error)) {
    console.warn(`[DATABASE]: missing row during ${where}; answered 404`);

    return createRecordNotFoundError();
  }

  if (isRawDatabaseError(error)) {
    console.error(`[DATABASE]: error during ${where}; answered 500 without details`, error);

    return createDatabaseError();
  }

  return null;
};
