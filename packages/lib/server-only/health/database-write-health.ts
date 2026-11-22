import { prisma } from '@documenso/prisma';

/**
 * Solid Ten: does the database take writes (DISK-L2)?
 *
 * On a full database disk the health check said "database ok" while every create failed: a read
 * (SELECT 1) and even small updates still work; only writes that need new space fail. Postgres
 * offers no disk-free reading to an ordinary user, so two signals are used:
 * - real writes: every request or job that failed because the database could not take it
 *   (database-errors.ts) records the time; writes count as failing for WRITE_FAILURE_WINDOW_MS
 *   after the last one;
 * - a probe: a one-row update in a transaction that is rolled back, with a 2 s statement
 *   timeout. It catches a read-only, recovering or unreachable database. Its result is reused for
 *   PROBE_CACHE_MS, so the public health URL cannot be used to hammer the database.
 */
export const WRITE_FAILURE_WINDOW_MS = 60_000;
export const PROBE_CACHE_MS = 15_000;

type TState = { lastFailureAt: number | null; probe: { at: number; ok: boolean } | null };

declare global {
  // eslint-disable-next-line no-var
  var __solidten_database_write_health__: TState | undefined;
}

// One state per process: the server is two bundles with their own module copies.
const state = (): TState => {
  globalThis.__solidten_database_write_health__ ??= { lastFailureAt: null, probe: null };

  return globalThis.__solidten_database_write_health__;
};

export const recordDatabaseWriteFailure = (now = Date.now()) => {
  state().lastFailureAt = now;
};

export const getLastDatabaseWriteFailureAt = () => state().lastFailureAt;

class ProbeRollback extends Error {}

const runWriteProbe = async () => {
  try {
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL statement_timeout = 2000`;
        await tx.$executeRaw`UPDATE "Counter" SET "value" = "value" WHERE "id" = 'document'`;

        throw new ProbeRollback();
      },
      { timeout: 5_000, maxWait: 2_000 },
    );

    return true;
  } catch (error) {
    return error instanceof ProbeRollback;
  }
};

export type TDatabaseWriteHealth = {
  writes: 'ok' | 'failing';
  lastWriteFailureAt: string | null;
  probe: 'ok' | 'failed';
};

export const getDatabaseWriteHealth = async (now = Date.now()): Promise<TDatabaseWriteHealth> => {
  const current = state();

  if (!current.probe || now - current.probe.at > PROBE_CACHE_MS) {
    current.probe = { at: now, ok: await runWriteProbe() };
  }

  const recentFailure = current.lastFailureAt !== null && now - current.lastFailureAt < WRITE_FAILURE_WINDOW_MS;

  return {
    writes: recentFailure || !current.probe.ok ? 'failing' : 'ok',
    lastWriteFailureAt: current.lastFailureAt ? new Date(current.lastFailureAt).toISOString() : null,
    probe: current.probe.ok ? 'ok' : 'failed',
  };
};
