import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { AppError } from './app-error';
import { isDatabaseUnavailableError, isRawDatabaseError, toPublicDatabaseError } from './database-errors';

// The text Prisma gave on the load tester's full disk (f3_diskfull.log).
const diskFullText =
  '\nInvalid `prisma.documentData.create()` invocation:\n\n\nError occurred during query execution:\n' +
  'ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "53100", ' +
  'message: "could not extend file \\"base/16384/16652\\": No space left on device", severity: "ERROR" }) })';

const known = (code: string, message = 'x') =>
  new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: '6' });

describe('database errors (DISK-L1)', () => {
  it('a full disk, an unreachable or restarting server count as unavailable', () => {
    expect(
      isDatabaseUnavailableError(new Prisma.PrismaClientUnknownRequestError(diskFullText, { clientVersion: '6' })),
    ).toBe(true);
    expect(isDatabaseUnavailableError(known('P1001', "Can't reach database server at `db:5432`"))).toBe(true);
    expect(isDatabaseUnavailableError(known('P1017', 'Server has closed the connection.'))).toBe(true);
    expect(isDatabaseUnavailableError(known('P2024', 'Timed out fetching a new connection'))).toBe(true);
    expect(isDatabaseUnavailableError(new Prisma.PrismaClientInitializationError('no db', '6'))).toBe(true);
    expect(
      isDatabaseUnavailableError(
        new Prisma.PrismaClientUnknownRequestError(
          'Invalid `prisma.x.y()` invocation: FATAL: the database system is starting up',
          { clientVersion: '6' },
        ),
      ),
    ).toBe(true);
  });

  it('is found behind the wrappers tRPC and AppError put around it', () => {
    const wrapped = new AppError('P2010', { message: diskFullText });
    expect(isDatabaseUnavailableError({ name: 'TRPCError', message: 'x', cause: wrapped })).toBe(true);
  });

  it('other database errors are raw but not unavailable; app errors are neither', () => {
    expect(isDatabaseUnavailableError(known('P2002', 'Unique constraint failed'))).toBe(false);
    expect(isRawDatabaseError(known('P2002', 'Unique constraint failed'))).toBe(true);
    expect(isRawDatabaseError(new AppError('NOT_FOUND', { message: 'Document not found' }))).toBe(false);
    expect(isDatabaseUnavailableError(new Error('JavaScript heap out of memory'))).toBe(false);
  });

  it('the public answer carries no internals', () => {
    const unavailable = toPublicDatabaseError(
      new Prisma.PrismaClientUnknownRequestError(diskFullText, { clientVersion: '6' }),
    );
    expect(unavailable).toMatchObject({
      code: 'DATABASE_UNAVAILABLE',
      statusCode: 503,
      message: 'Temporarily unable to save. Try again in a few minutes.',
      headers: { 'Retry-After': '30' },
    });

    const other = toPublicDatabaseError(known('P2003', 'Foreign key constraint failed on the field: `teamId`'));
    expect(other).toMatchObject({ statusCode: 500, message: 'Something went wrong. Try again.' });
    expect(JSON.stringify(other)).not.toMatch(/prisma|teamId|constraint/i);

    expect(toPublicDatabaseError(new AppError('NOT_FOUND'))).toBeNull();
  });
});
