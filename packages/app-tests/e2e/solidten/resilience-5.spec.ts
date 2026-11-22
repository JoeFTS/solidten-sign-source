import fs from 'node:fs';
import path from 'node:path';
import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { createApiToken } from '@documenso/lib/server-only/public-api/create-api-token';
import { prisma } from '@documenso/prisma';
import { EnvelopeType, RecipientRole } from '@documenso/prisma/client';
import { seedUser } from '@documenso/prisma/seed/users';
import type {
  TCreateEnvelopePayload,
  TCreateEnvelopeResponse,
} from '@documenso/trpc/server/envelope-router/create-envelope.types';
import type { APIRequestContext } from '@playwright/test';
import { expect, test } from '@playwright/test';

/**
 * Solid Ten: recovery after crashes and restarts, round 7 (FS3-M1, FS3-L1).
 */

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();
const apiUrl = `${WEBAPP_BASE_URL}/api/v2-beta`;

const examplePdf = fs.readFileSync(path.join(__dirname, '../../../../assets/example.pdf'));

const uniqueEmail = (tag: string) => `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@resilience.test`;

const createOwner = async () => {
  const { user, team } = await seedUser();

  const { token } = await createApiToken({
    userId: user.id,
    teamId: team.id,
    tokenName: 'resilience',
    expiresIn: null,
  });

  return { user, team, authHeaders: { Authorization: `Bearer ${token}` } };
};

type Owner = Awaited<ReturnType<typeof createOwner>>;

const createAndSend = async (
  request: APIRequestContext,
  owner: Owner,
  signerEmails: string[],
  meta: TCreateEnvelopePayload['meta'] = {},
) => {
  const payload: TCreateEnvelopePayload = {
    type: EnvelopeType.DOCUMENT,
    title: '[TEST] Resilience',
    meta: { distributionMethod: 'EMAIL', ...meta },
    recipients: signerEmails.map((email, index) => ({
      email,
      name: `Signer ${index + 1}`,
      role: RecipientRole.SIGNER,
      signingOrder: index + 1,
      fields: [
        {
          type: 'SIGNATURE',
          page: 1,
          positionX: 10,
          positionY: 10 + (index % 8) * 10,
          width: 10,
          height: 5,
          fieldMeta: { type: 'signature' },
        },
      ],
    })),
  };

  const formData = new FormData();
  formData.append('payload', JSON.stringify(payload));
  formData.append('files', new File([examplePdf], 'example.pdf', { type: 'application/pdf' }));

  const createRes = await request.post(`${apiUrl}/envelope/create`, {
    headers: owner.authHeaders,
    multipart: formData,
  });
  expect(createRes.ok(), await createRes.text()).toBeTruthy();

  const { id: envelopeId }: TCreateEnvelopeResponse = await createRes.json();

  const distributeRes = await request.post(`${apiUrl}/envelope/distribute`, {
    headers: owner.authHeaders,
    data: { envelopeId },
  });
  expect(distributeRes.ok(), await distributeRes.text()).toBeTruthy();

  const envelope = await prisma.envelope.findUniqueOrThrow({
    where: { id: envelopeId },
    include: { recipients: { include: { fields: true }, orderBy: { signingOrder: 'asc' } } },
  });

  return { envelopeId, envelope, documentId: Number(envelope.secondaryId.split('_').pop()) };
};

const waitFor = async (check: () => Promise<boolean>, timeoutMs = 60_000) => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await check()) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return false;
};

/**
 * Make the database refuse writes the way a full disk does, for one table and one scope only, for
 * the length of `run`. A test-only trigger; dropped afterwards.
 */
const withDatabaseFault = async <T>(
  options: { table: string; when: 'INSERT' | 'UPDATE'; condition: string; sqlstate?: string; message?: string },
  run: () => Promise<T>,
) => {
  const name = `st_test_fault_${Math.random().toString(36).slice(2, 10)}`;
  const sqlstate = options.sqlstate ?? '53100';
  const message = (options.message ?? 'could not extend file "base/16384/16652": No space left on device').replace(
    /'/g,
    "''",
  );

  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION ${name}() RETURNS trigger AS $$
    BEGIN
      IF ${options.condition} THEN
        RAISE EXCEPTION USING ERRCODE = '${sqlstate}', MESSAGE = '${message}';
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`);
  await prisma.$executeRawUnsafe(
    `CREATE TRIGGER ${name} BEFORE ${options.when} ON "${options.table}" FOR EACH ROW EXECUTE FUNCTION ${name}()`,
  );

  try {
    return await run();
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${name} ON "${options.table}"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${name}()`);
  }
};

const insertLostJob = async (jobId: string, payload: Record<string, unknown>, ageMinutes = 5) => {
  const job = await prisma.backgroundJob.create({ data: { jobId, name: jobId, version: '1.0.0', payload } });

  await prisma.$executeRaw`UPDATE "BackgroundJob" SET "updatedAt" = now() - (${ageMinutes} * interval '1 minute') WHERE "id" = ${job.id}`;

  return job;
};

const sleep = async (ms: number) => await new Promise((resolve) => setTimeout(resolve, ms));

const getProvider = async () => {
  const { LocalJobProvider } = await import('@documenso/lib/jobs/client/local');

  return LocalJobProvider.getInstance();
};

const MAIL_SINK_URL = process.env.E2E_MAIL_SINK_URL;

const findMailSubjects = async (to: string) => {
  const res = await fetch(`${MAIL_SINK_URL}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
  const body = (await res.json()) as { messages?: { Subject: string }[] };

  return (body.messages ?? []).map((message) => message.Subject);
};

const reminderAuditCount = async (envelopeId: string, recipientId: number) =>
  await prisma.documentAuditLog.count({
    where: {
      envelopeId,
      type: 'EMAIL_SENT',
      AND: [
        { data: { path: ['emailType'], equals: 'REMINDER' } },
        { data: { path: ['recipientId'], equals: recipientId } },
      ],
    },
  });

const jobStatus = async (id: string) => (await prisma.backgroundJob.findUniqueOrThrow({ where: { id } })).status;

// A refused write leaves the server's health "degraded" for up to a minute (DISK-L2); the specs
// that run after this file expect a healthy server.
test.afterAll(async ({ request }) => {
  test.setTimeout(150_000);

  await waitFor(async () => (await request.get(`${WEBAPP_BASE_URL}/api/health`)).status() === 200, 120_000);
});

test.describe('[RESILIENCE-5] FS3-L1 a sent message whose completion could not be recorded', () => {
  test.describe.configure({ timeout: 180_000 });

  test('is not sent again when the job runs again', async ({ request }) => {
    test.skip(!MAIL_SINK_URL, 'needs E2E_MAIL_SINK_URL to count the emails');

    const owner = await createOwner();
    const email = uniqueEmail('record');
    const { envelopeId, envelope } = await createAndSend(request, owner, [email]);
    const [recipient] = envelope.recipients;

    expect(
      await waitFor(
        async () => (await prisma.recipient.findUniqueOrThrow({ where: { id: recipient.id } })).sendStatus === 'SENT',
      ),
    ).toBe(true);
    await prisma.recipient.update({
      where: { id: recipient.id },
      data: { nextReminderAt: new Date(Date.now() - 60_000) },
    });

    const job = await insertLostJob('internal.process-signing-reminder', { recipientId: recipient.id });
    const provider = await getProvider();

    // The send goes out; the write that records the task as done is refused (a starved pool).
    await withDatabaseFault(
      {
        table: 'BackgroundJobTask',
        when: 'UPDATE',
        condition: `NEW."jobId" = '${job.id}' AND NEW."name" = 'send-reminder' AND NEW."status" = 'COMPLETED'`,
        sqlstate: '53300',
        message: 'sorry, too many clients already',
      },
      async () => {
        expect((await provider.runRecovery({ jobIds: [job.id] })).resubmitted).toEqual([job.id]);
        expect(await waitFor(async () => (await reminderAuditCount(envelopeId, recipient.id)) === 1, 30_000)).toBe(
          true,
        );
        expect(await waitFor(async () => (await jobStatus(job.id)) === 'PENDING', 30_000)).toBe(true);
      },
    );

    // The job runs again once the database is fine.
    await provider.runRecovery({ jobIds: [job.id], now: new Date(Date.now() + 5 * 60_000) });
    expect(await waitFor(async () => (await jobStatus(job.id)) === 'COMPLETED', 60_000)).toBe(true);
    await sleep(2_000);

    const reminders = (await findMailSubjects(email)).filter((subject) => subject.startsWith('Reminder'));
    expect(reminders).toHaveLength(1);
    expect(await reminderAuditCount(envelopeId, recipient.id)).toBe(1);
  });
});

test.describe('[RESILIENCE-5] FS3-L1 a burst of jobs', () => {
  test.describe.configure({ timeout: 240_000 });

  test('runs at most NEXT_PRIVATE_ST_JOB_CONCURRENCY (default 6) at a time, and every job once', async ({
    request,
  }) => {
    const owner = await createOwner();
    const { envelopeId, envelope } = await createAndSend(
      request,
      owner,
      Array.from({ length: 20 }, (_, index) => uniqueEmail(`burst${index}`)),
    );

    expect(
      await waitFor(
        async () => (await prisma.recipient.count({ where: { envelopeId, sendStatus: 'SENT' } })) === 20,
        90_000,
      ),
    ).toBe(true);
    await prisma.recipient.updateMany({
      where: { envelopeId },
      data: { nextReminderAt: new Date(Date.now() - 60_000) },
    });

    // The database itself records how many claims overlap: each reminder claim updates its
    // recipient, and a test-only trigger logs start and end around a short sleep.
    const log = `st_test_overlap_${Math.random().toString(36).slice(2, 8)}`;
    const fn = `${log}_fn`;
    await prisma.$executeRawUnsafe(`CREATE TABLE ${log} (started timestamptz, ended timestamptz)`);
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION ${fn}() RETURNS trigger AS $$
      DECLARE t timestamptz := clock_timestamp();
      BEGIN
        IF NEW."envelopeId" = '${envelopeId}' AND NEW."lastReminderSentAt" IS DISTINCT FROM OLD."lastReminderSentAt" THEN
          PERFORM pg_sleep(2);
          INSERT INTO ${log} VALUES (t, clock_timestamp());
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER ${fn} BEFORE UPDATE ON "Recipient" FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
    );

    try {
      const jobs = await Promise.all(
        envelope.recipients.map(
          async (recipient) => await insertLostJob('internal.process-signing-reminder', { recipientId: recipient.id }),
        ),
      );
      const provider = await getProvider();
      expect((await provider.runRecovery({ jobIds: jobs.map((job) => job.id) })).resubmitted).toHaveLength(20);

      expect(
        await waitFor(
          async () =>
            (await prisma.backgroundJob.count({
              where: { id: { in: jobs.map((job) => job.id) }, status: 'COMPLETED' },
            })) === 20,
          180_000,
        ),
      ).toBe(true);

      // The most claims running at one moment (at each claim's start).
      const [{ overlap }] = await prisma.$queryRawUnsafe<{ overlap: number }[]>(`
        SELECT max(c)::int AS overlap FROM (
          SELECT (SELECT count(*) FROM ${log} b WHERE b.started <= a.started AND b.ended > a.started) AS c FROM ${log} a
        ) x`);

      expect(overlap).toBeGreaterThan(1);
      expect(overlap).toBeLessThanOrEqual(6);

      for (const recipient of envelope.recipients) {
        expect(await reminderAuditCount(envelopeId, recipient.id)).toBe(1);
      }
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${fn} ON "Recipient"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${fn}()`);
      await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS ${log}`);
    }
  });
});

/** Rows as a kill leaves them: PROCESSING, last touched `minutesAgo` minutes ago. */
const insertCutOffJobs = async (
  rows: { jobId: string; payload: Record<string, unknown>; cutOffCount?: number }[],
  minutesAgo = 10,
) => {
  const jobs = await Promise.all(
    rows.map(
      async (row) =>
        await prisma.backgroundJob.create({
          data: {
            jobId: row.jobId,
            name: row.jobId,
            version: '1.0.0',
            payload: row.payload,
            cutOffCount: row.cutOffCount ?? null,
          },
        }),
    ),
  );

  await prisma.$executeRawUnsafe(
    `UPDATE "BackgroundJob" SET "status" = 'PROCESSING', "updatedAt" = now() - interval '${minutesAgo} minutes' WHERE "id" IN (${jobs.map((job) => `'${job.id}'`).join(',')})`,
  );

  return jobs;
};

test.describe('[RESILIENCE-5] FS3-M1 recovery after a crash with many jobs in flight', () => {
  test.describe.configure({ timeout: 600_000 });

  test('100 jobs cut off by one crash all run again within minutes, each exactly once', async ({ request }) => {
    const owner = await createOwner();
    const { envelopeId, envelope } = await createAndSend(
      request,
      owner,
      Array.from({ length: 100 }, (_, index) => uniqueEmail(`crash${index}`)),
    );

    expect(
      await waitFor(
        async () => (await prisma.recipient.count({ where: { envelopeId, sendStatus: 'SENT' } })) === 100,
        240_000,
      ),
    ).toBe(true);
    await prisma.recipient.updateMany({
      where: { envelopeId },
      data: { nextReminderAt: new Date(Date.now() - 60_000) },
    });

    const jobs = await insertCutOffJobs(
      envelope.recipients.map((recipient) => ({
        jobId: 'internal.process-signing-reminder',
        payload: { recipientId: recipient.id },
      })),
    );
    const ids = jobs.map((job) => job.id);
    const provider = await getProvider();

    // The restarted app's sweep: every row is counted, none is taken for a poison job.
    const first = await provider.runRecovery({ jobIds: ids });
    expect(first.rescheduled).toHaveLength(100);
    expect(await prisma.backgroundJob.count({ where: { id: { in: ids }, lastCrashedAt: { not: null } } })).toBe(0);

    // After the short wait they all go together (not one a minute).
    const startedAt = Date.now();
    const second = await provider.runRecovery({ jobIds: ids, now: new Date(Date.now() + 2 * 60_000) });
    expect(second.resubmitted).toHaveLength(100);

    expect(
      await waitFor(
        async () => (await prisma.backgroundJob.count({ where: { id: { in: ids }, status: 'COMPLETED' } })) === 100,
        240_000,
      ),
    ).toBe(true);
    console.log(
      `[FS3-M1] 100 cut-off jobs completed ${Math.round((Date.now() - startedAt) / 1000)} s after their wait`,
    );

    for (const recipient of envelope.recipients) {
      expect(await reminderAuditCount(envelopeId, recipient.id)).toBe(1);
    }

    // Later tests must not see these as cut off "at the same time" as theirs.
    await prisma.backgroundJob.updateMany({
      where: { id: { in: ids } },
      data: { lastRetriedAt: new Date(Date.now() - 60 * 60_000) },
    });
  });

  test('a row cut off a second time, or cut off alone, is still run alone and spaced', async () => {
    const [again, other1, other2] = await insertCutOffJobs([
      { jobId: 'internal.process-signing-reminder', payload: { recipientId: 999_999_990 }, cutOffCount: 1 },
      { jobId: 'internal.process-signing-reminder', payload: { recipientId: 999_999_991 } },
      { jobId: 'internal.process-signing-reminder', payload: { recipientId: 999_999_992 } },
    ]);
    const provider = await getProvider();

    await provider.runRecovery({ jobIds: [again.id, other1.id, other2.id] });

    const rows = await prisma.backgroundJob.findMany({ where: { id: { in: [again.id, other1.id, other2.id] } } });
    const byId = new Map(rows.map((row) => [row.id, row]));

    expect(byId.get(again.id)?.lastCrashedAt).not.toBeNull();
    expect(byId.get(again.id)?.cutOffCount).toBe(2);
    expect(byId.get(other1.id)?.lastCrashedAt).toBeNull();
    expect(byId.get(other1.id)?.cutOffCount).toBe(1);

    // Cut off alone: suspect on its first cut-off.
    const [lone] = await insertCutOffJobs([
      { jobId: 'internal.process-signing-reminder', payload: { recipientId: 999_999_993 } },
    ]);
    await prisma.backgroundJob.updateMany({
      where: { id: { in: [again.id, other1.id, other2.id] } },
      data: { status: 'FAILED' },
    });
    await prisma.backgroundJob.updateMany({
      where: { cutOffCount: { gte: 1 }, id: { not: lone.id } },
      data: { lastRetriedAt: new Date(Date.now() - 60 * 60_000) },
    });

    await provider.runRecovery({ jobIds: [lone.id] });
    expect((await prisma.backgroundJob.findUniqueOrThrow({ where: { id: lone.id } })).lastCrashedAt).not.toBeNull();

    await prisma.backgroundJob.updateMany({
      where: { id: { in: [lone.id, again.id, other1.id, other2.id] } },
      data: { status: 'FAILED', lastRetriedAt: new Date(Date.now() - 60 * 60_000) },
    });
  });
});

test.describe('[RESILIENCE-5] FS3-M1 a restart (SIGTERM) drains jobs', () => {
  test.describe.configure({ timeout: 120_000 });

  test('in-flight runs may finish; the rest are marked interrupted, not crashed; new runs are refused and made due', async () => {
    const { createJobShutdownMiddleware, drainJobs, trackJobRequest } = await import(
      '@documenso/lib/jobs/client/graceful-shutdown'
    );
    const { Hono } = await import('hono');

    const [slow, quick] = await insertCutOffJobs(
      [
        { jobId: 'internal.process-signing-reminder', payload: { recipientId: 999_999_980 } },
        { jobId: 'internal.process-signing-reminder', payload: { recipientId: 999_999_981 } },
      ],
      0,
    );
    await prisma.backgroundJob.update({ where: { id: slow.id }, data: { retried: 1 } });
    const arriving = await prisma.backgroundJob.create({
      data: {
        jobId: 'internal.process-signing-reminder',
        name: 'x',
        version: '1.0.0',
        payload: { recipientId: 999_999_982 },
      },
    });

    try {
      // Two runs in this process: one ends within the drain, one does not.
      void trackJobRequest(slow.id, async () => await new Promise(() => {}));
      void trackJobRequest(quick.id, async () => await sleep(300));

      const drained = await drainJobs({ timeoutMs: 1_500 });
      expect(drained).toEqual({ startedInFlight: 2, finished: 1, interrupted: 1 });

      const interrupted = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: slow.id } });
      expect(interrupted.status).toBe('PENDING');
      expect(interrupted.nextRunAt?.getTime()).toBeLessThanOrEqual(Date.now());
      expect(interrupted.retried).toBe(0);
      expect(interrupted.lastCrashedAt).toBeNull();
      expect(interrupted.cutOffCount).toBeNull();

      // A job run that arrives now is refused before its claim, and made due for the next start.
      const app = new Hono();
      app.use('*', createJobShutdownMiddleware());
      app.post('*', (c) => c.text('ran'));
      const refused = await app.request('/api/jobs/x', { method: 'POST', headers: { 'x-job-id': arriving.id } });
      expect(refused.status).toBe(503);
      expect((await prisma.backgroundJob.findUniqueOrThrow({ where: { id: arriving.id } })).nextRunAt).not.toBeNull();

      // The recovery sweep of a process that shuts down claims nothing.
      const provider = await getProvider();
      expect((await provider.runRecovery({ jobIds: [arriving.id] })).resubmitted).toEqual([]);
    } finally {
      globalThis.__solidten_shutdown__ = undefined;
      await prisma.backgroundJob.updateMany({
        where: { id: { in: [slow.id, quick.id, arriving.id] } },
        data: { status: 'FAILED' },
      });
    }
  });

  test('a run still waiting for a job slot does not start: it is marked interrupted at once', async () => {
    const { drainJobs, trackJobRequest } = await import('@documenso/lib/jobs/client/graceful-shutdown');
    const { waitForJobSlot } = await import('@documenso/lib/jobs/client/job-slots');

    const [queued] = await insertCutOffJobs(
      [{ jobId: 'internal.process-signing-reminder', payload: { recipientId: 999_999_983 } }],
      0,
    );

    // Every slot of this process taken by work that is not tracked here.
    const held = await Promise.all(
      Array.from({ length: 6 }, async (_, index) => await waitForJobSlot(`held-${index}`)),
    );
    let didStart = false;

    try {
      void trackJobRequest(queued.id, async () => {
        const release = await waitForJobSlot(queued.id);
        didStart = true;
        release();
      });

      const startedAt = Date.now();
      const drained = await drainJobs({ timeoutMs: 10_000 });

      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(drained).toMatchObject({ startedInFlight: 1, finished: 0, interrupted: 1 });

      // Freed slots are not handed on while the process shuts down.
      for (const release of held) {
        release();
      }
      await sleep(200);
      expect(didStart).toBe(false);
      expect((await prisma.backgroundJob.findUniqueOrThrow({ where: { id: queued.id } })).status).toBe('PENDING');
    } finally {
      globalThis.__solidten_shutdown__ = undefined;
      globalThis.__solidten_job_slots__ = undefined;
      await prisma.backgroundJob.update({ where: { id: queued.id }, data: { status: 'FAILED' } });
    }
  });
});

test.describe('[RESILIENCE-5] a job that runs longer than its PROCESSING timeout', () => {
  test('is not taken for a cut-off one (and started a second time) while it still runs', async () => {
    const { withJobSlot } = await import('@documenso/lib/jobs/client/job-slots');

    // Claimed 10 minutes ago: past the 5 minute timeout of most jobs.
    const [running] = await insertCutOffJobs(
      [{ jobId: 'internal.process-signing-reminder', payload: { recipientId: 999_999_970 } }],
      10,
    );
    const provider = await getProvider();

    try {
      // The run is alive: its slot keeps the row fresh (here every 200 ms instead of every minute).
      await withJobSlot({ jobId: running.id, heartbeatMs: 200 }, async () => await sleep(700));

      const result = await provider.runRecovery({ jobIds: [running.id] });
      expect(result.rescheduled).toEqual([]);
      expect((await prisma.backgroundJob.findUniqueOrThrow({ where: { id: running.id } })).status).toBe('PROCESSING');
    } finally {
      globalThis.__solidten_job_slots__ = undefined;
      await prisma.backgroundJob.update({ where: { id: running.id }, data: { status: 'FAILED' } });
    }
  });
});
