/**
 * Solid Ten: which errors come from the database, and which of those mean "the database cannot
 * take requests now" (DISK-L1). Pure functions with no imports, so app-error.ts can use them.
 * See database-errors.ts for the answers.
 */
/** Prisma: cannot reach, timed out, closed connection, pool timeout, too many connections. */
const UNAVAILABLE_PRISMA_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2037']);

/**
 * Postgres SQLSTATE classes: 53 insufficient resources (53100 disk full, 53200 out of memory,
 * 53300 too many connections), 57P0x shutdown and startup, 08 connection exceptions.
 */
const UNAVAILABLE_SQLSTATE = /\b(53\d{3}|57P0[1-4]|08(000|001|003|004|006|P01))\b/;

const UNAVAILABLE_TEXT =
  /No space left on device|could not extend file|could not write to file|Can't reach database server|Server has closed the connection|Connection refused|ECONNREFUSED|ECONNRESET|terminating connection|the database system is (starting up|shutting down|in recovery mode|not yet accepting connections)|Timed out fetching a new connection|too many clients already|out of memory/i;

const RAW_TEXT = /Invalid `prisma\.|prisma\.\w+\.\w+\(\)` invocation|ConnectorError|PostgresError|SQLSTATE/;

type TErrorLike = { name?: unknown; code?: unknown; message?: unknown; cause?: unknown };

/** The error and its causes (tRPC and AppError wrap the original), at most a few levels deep. */
const chain = (error: unknown): TErrorLike[] => {
  const result: TErrorLike[] = [];
  let current: unknown = error;

  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth++) {
    result.push(current as TErrorLike);
    current = (current as TErrorLike).cause;
  }

  return result;
};

const textOf = (error: TErrorLike) => (typeof error.message === 'string' ? error.message : '');

const isPrismaError = (error: TErrorLike) => typeof error.name === 'string' && error.name.startsWith('PrismaClient');

export const isDatabaseUnavailableError = (error: unknown): boolean =>
  chain(error).some((entry) => {
    if (entry.name === 'PrismaClientInitializationError') {
      return true;
    }

    if (typeof entry.code === 'string' && UNAVAILABLE_PRISMA_CODES.has(entry.code)) {
      return true;
    }

    const text = textOf(entry);

    // Only database errors: an unrelated "out of memory" in, say, PDF work is not a database fault.
    const isFromDatabase = isPrismaError(entry) || RAW_TEXT.test(text) || /^P\d{4}$/.test(String(entry.code));

    return isFromDatabase && (UNAVAILABLE_SQLSTATE.test(text) || UNAVAILABLE_TEXT.test(text));
  });

/** A Prisma error, or an error that still carries Prisma's text or code. */
export const isRawDatabaseError = (error: unknown): boolean =>
  chain(error).some(
    (entry) => isPrismaError(entry) || RAW_TEXT.test(textOf(entry)) || /^P\d{4}$/.test(String(entry.code)),
  );

/**
 * Solid Ten Sign (L-3): Prisma's "the row is not there" errors: P2025 (a record to update, delete
 * or find-or-throw does not exist), P2015 and P2018 (a related record not found). They mean the
 * thing was deleted, often a moment before. Not P2003 (a foreign key): it also means "still in
 * use" on a delete, which is not a 404.
 */
const MISSING_RECORD_PRISMA_CODES = new Set(['P2025', 'P2015', 'P2018']);

export const isMissingRecordError = (error: unknown): boolean =>
  chain(error).some((entry) => typeof entry.code === 'string' && MISSING_RECORD_PRISMA_CODES.has(entry.code));
