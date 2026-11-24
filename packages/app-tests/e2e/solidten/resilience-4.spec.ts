import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { recordDatabaseWriteFailure } from '@documenso/lib/server-only/health/database-write-health';
import { createApiToken } from '@documenso/lib/server-only/public-api/create-api-token';
import { prisma } from '@documenso/prisma';
import { EnvelopeType, RecipientRole } from '@documenso/prisma/client';
import { seedTemplate } from '@documenso/prisma/seed/templates';
import { seedUser } from '@documenso/prisma/seed/users';
import type {
  TCreateEnvelopePayload,
  TCreateEnvelopeResponse,
} from '@documenso/trpc/server/envelope-router/create-envelope.types';
import type { APIRequestContext } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { apiSignin, WEBAPP_ORIGIN_HEADERS } from '../fixtures/authentication';
import { healthHeaders } from '../fixtures/health';

/**
 * Solid Ten: database outages and full disks (DISK-L1, DISK-L2, DISK-I1), round 5 additions.
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
          positionY: 10 + index * 10,
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

const signAllFields = async (request: APIRequestContext, token: string, fieldIds: number[]) => {
  for (const fieldId of fieldIds) {
    const res = await request.post(`${WEBAPP_BASE_URL}/api/trpc/envelope.field.sign`, {
      headers: { ...WEBAPP_ORIGIN_HEADERS, 'content-type': 'application/json' },
      data: JSON.stringify({ json: { token, fieldId, fieldValue: { type: 'SIGNATURE', value: 'Race Signer' } } }),
    });

    expect(res.ok(), await res.text()).toBeTruthy();
  }
};

const completeWithToken = async (request: APIRequestContext, token: string, documentId: number) =>
  await request.post(`${WEBAPP_BASE_URL}/api/trpc/recipient.completeDocumentWithToken`, {
    headers: { ...WEBAPP_ORIGIN_HEADERS, 'content-type': 'application/json' },
    data: JSON.stringify({ json: { token, documentId } }),
  });

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

const INTERNALS = /prisma|invocation|ConnectorError|PostgresError|SQLSTATE|53100|base\/\d+|No space left|constraint/i;

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

const createViaApi = async (request: APIRequestContext, owner: Owner, title: string) => {
  const formData = new FormData();
  formData.append('payload', JSON.stringify({ type: EnvelopeType.DOCUMENT, title, recipients: [] }));
  formData.append('files', new File([examplePdf], 'example.pdf', { type: 'application/pdf' }));

  return await request.post(`${apiUrl}/envelope/create`, { headers: owner.authHeaders, multipart: formData });
};

// The refused writes above leave the server's health "degraded" for up to a minute; the specs that
// run after this file expect a healthy server.
test.afterAll(async ({ request }) => {
  test.setTimeout(150_000);

  await waitFor(async () => (await request.get(`${WEBAPP_BASE_URL}/api/health`)).status() === 200, 120_000);
});

test.describe('[RESILIENCE-4] DISK-L1 a full database disk', () => {
  test.describe.configure({ timeout: 120_000 });

  test('API v2 create answers 503 "temporarily unable to save" with no internals, and nothing is created', async ({
    request,
  }) => {
    const owner = await createOwner();

    const res = await withDatabaseFault(
      { table: 'Envelope', when: 'INSERT', condition: `NEW."teamId" = ${owner.team.id}` },
      async () => await createViaApi(request, owner, '[TEST] Full disk'),
    );
    const text = await res.text();

    expect(res.status(), text).toBe(503);
    expect(text).toContain('Temporarily unable to save. Try again in a few minutes.');
    expect(text).not.toMatch(INTERNALS);
    expect(Number(res.headers()['retry-after'])).toBeGreaterThan(0);
    expect(await prisma.envelope.count({ where: { teamId: owner.team.id } })).toBe(0);

    // When space returns, the same request works.
    expect((await createViaApi(request, owner, '[TEST] Full disk')).status()).toBe(200);
  });

  test('a field sign (tRPC) answers 503 with no internals', async ({ request }) => {
    const owner = await createOwner();
    const { envelope } = await createAndSend(request, owner, [uniqueEmail('diskfull')]);
    const [recipient] = envelope.recipients;
    const [field] = recipient.fields;

    const res = await withDatabaseFault(
      { table: 'Field', when: 'UPDATE', condition: `NEW."envelopeId" = '${envelope.id}'` },
      async () =>
        await request.post(`${WEBAPP_BASE_URL}/api/trpc/envelope.field.sign`, {
          headers: { ...WEBAPP_ORIGIN_HEADERS, 'content-type': 'application/json' },
          data: JSON.stringify({
            json: { token: recipient.token, fieldId: field.id, fieldValue: { type: 'SIGNATURE', value: 'Disk Full' } },
          }),
        }),
    );
    const text = await res.text();

    expect(res.status(), text).toBe(503);
    expect(text).toContain('Temporarily unable to save. Try again in a few minutes.');
    expect(text).toContain('DATABASE_UNAVAILABLE');
    expect(text).not.toMatch(INTERNALS);
  });

  test('API v1 answers 503 with no internals (not 401 or 500)', async ({ request }) => {
    const owner = await createOwner();
    const template = await seedTemplate({ title: '[TEST] v1 disk', userId: owner.user.id, teamId: owner.team.id });
    const [templateRecipient] = template.recipients;
    const templateId = Number(template.secondaryId.split('_').pop());

    const res = await withDatabaseFault(
      { table: 'Envelope', when: 'INSERT', condition: `NEW."teamId" = ${owner.team.id} AND NEW."type" = 'DOCUMENT'` },
      async () =>
        await request.post(`${WEBAPP_BASE_URL}/api/v1/templates/${templateId}/generate-document`, {
          headers: { ...owner.authHeaders, 'content-type': 'application/json' },
          data: { recipients: [{ id: templateRecipient.id, email: uniqueEmail('v1'), name: 'V1 Signer' }] },
        }),
    );
    const text = await res.text();

    expect(res.status(), text).toBe(503);
    expect(text).toContain('Temporarily unable to save');
    expect(text).not.toMatch(INTERNALS);
  });

  test('the upload route answers 503 with a code and no internals', async ({ page }) => {
    const owner = await createOwner();
    await apiSignin({ page, email: owner.user.email });

    const formData = new FormData();
    formData.append('file', new File([examplePdf], 'example.pdf', { type: 'application/pdf' }));

    // DocumentData has no owner column: refuse every insert, for this request only (one worker).
    const res = await withDatabaseFault(
      { table: 'DocumentData', when: 'INSERT', condition: 'true' },
      async () =>
        await page.context().request.post(`${WEBAPP_BASE_URL}/api/files/upload-pdf`, {
          headers: WEBAPP_ORIGIN_HEADERS,
          multipart: formData,
        }),
    );
    const text = await res.text();

    expect(res.status(), text).toBe(503);
    expect(JSON.parse(text)).toEqual({
      error: 'Temporarily unable to save. Try again in a few minutes.',
      code: 'DATABASE_UNAVAILABLE',
    });
    expect(Number(res.headers()['retry-after'])).toBeGreaterThan(0);
  });

  test('any other database error answers a plain 500 without Prisma text', async ({ request }) => {
    const owner = await createOwner();

    const res = await withDatabaseFault(
      {
        table: 'Envelope',
        when: 'INSERT',
        condition: `NEW."teamId" = ${owner.team.id}`,
        sqlstate: '23514',
        message: 'new row for relation "Envelope" violates check constraint "st_test_check"',
      },
      async () => await createViaApi(request, owner, '[TEST] Other db error'),
    );
    const text = await res.text();

    expect(res.status(), text).toBe(500);
    expect(text).toContain('Something went wrong. Try again.');
    expect(text).not.toMatch(INTERNALS);
  });
});

test.describe('[RESILIENCE-4] DISK-L2 health while writes fail', () => {
  test.describe.configure({ timeout: 180_000 });

  test('health says "degraded" (503) while the database refuses writes, and "ok" again after', async ({ request }) => {
    const owner = await createOwner();

    const health = async () => {
      const res = await request.get(`${WEBAPP_BASE_URL}/api/health`, { headers: healthHeaders() });

      return { status: res.status(), body: await res.json() };
    };

    // Earlier tests in this file refused writes too: start from a healthy state.
    expect(await waitFor(async () => (await health()).status === 200, 120_000)).toBe(true);

    const refused = await withDatabaseFault(
      { table: 'Envelope', when: 'INSERT', condition: `NEW."teamId" = ${owner.team.id}` },
      async () => await createViaApi(request, owner, '[TEST] Health while full'),
    );
    expect(refused.status()).toBe(503);

    const during = await health();
    expect(during.status).toBe(503);
    expect(during.body.status).toBe('degraded');
    expect(during.body.checks.database).toEqual({ status: 'degraded', writes: 'failing' });
    // The detail (local call) says when.
    expect(during.body.databaseWrites?.lastWriteFailureAt).toBeTruthy();

    // No more refused writes: health recovers by itself within the window.
    expect(await waitFor(async () => (await health()).status === 200, 120_000)).toBe(true);
    expect((await health()).body.checks.database).toEqual({ status: 'ok' });
  });
});

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

test.describe('[RESILIENCE-4] DISK-I1 a job hit by a database outage', () => {
  test.describe.configure({ timeout: 180_000 });

  test('waits and runs later without spending its attempts', async ({ request }) => {
    const owner = await createOwner();
    const { envelopeId, envelope } = await createAndSend(request, owner, [uniqueEmail('outage')]);
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

    await withDatabaseFault(
      { table: 'Recipient', when: 'UPDATE', condition: `NEW."id" = ${recipient.id}` },
      async () => {
        expect((await provider.runRecovery({ jobIds: [job.id] })).resubmitted).toEqual([job.id]);

        // The claim's update is refused: the job goes back to wait, counted as nothing.
        expect(
          await waitFor(async () => {
            const row = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: job.id } });

            return row.status === 'PENDING' && row.nextRunAt !== null;
          }, 30_000),
        ).toBe(true);
        await sleep(3_000);

        const row = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: job.id } });
        expect(row.status).toBe('PENDING');
        expect(row.retried).toBe(0);
        expect(row.lastCrashedAt).toBeNull();
        expect(row.nextRunAt?.getTime()).toBeGreaterThan(Date.now());

        const tasks = await prisma.backgroundJobTask.findMany({ where: { jobId: job.id } });
        expect(tasks.every((task) => task.retried === 0)).toBe(true);
      },
    );

    // Space is back: the next sweep after the wait runs it, and the reminder goes out once.
    expect(
      (await provider.runRecovery({ jobIds: [job.id], now: new Date(Date.now() + 2 * 60_000) })).resubmitted,
    ).toEqual([job.id]);
    expect(
      await waitFor(
        async () => (await prisma.backgroundJob.findUniqueOrThrow({ where: { id: job.id } })).status === 'COMPLETED',
      ),
    ).toBe(true);
    expect(
      await prisma.documentAuditLog.count({
        where: {
          envelopeId,
          type: 'EMAIL_SENT',
          AND: [
            { data: { path: ['emailType'], equals: 'REMINDER' } },
            { data: { path: ['recipientId'], equals: recipient.id } },
          ],
        },
      }),
    ).toBe(1);
  });

  test('a job cut off while the database was down is re-run without counting it as a crash', async () => {
    const job = await insertLostJob('internal.process-signing-reminder', { recipientId: 999_999_996 }, 10);
    await prisma.$executeRaw`UPDATE "BackgroundJob" SET "status" = 'PROCESSING', "updatedAt" = now() - interval '10 minutes' WHERE "id" = ${job.id}`;

    // This process saw the database refuse requests after the job started.
    recordDatabaseWriteFailure();

    const provider = await getProvider();

    try {
      expect((await provider.runRecovery({ jobIds: [job.id] })).rescheduled).toEqual([job.id]);
    } finally {
      // The next spec files run in this process: do not leave an "outage" behind.
      globalThis.__solidten_database_write_health__ = undefined;
    }

    const row = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.status).toBe('PENDING');
    expect(row.retried).toBe(0);
    expect(row.lastCrashedAt).toBeNull();
    expect(row.nextRunAt?.getTime()).toBeGreaterThan(Date.now());

    await prisma.backgroundJob.update({ where: { id: job.id }, data: { status: 'FAILED' } });
  });
});

const MAIL_SINK_URL = process.env.E2E_MAIL_SINK_URL;

const findMailSubjects = async (to: string) => {
  const res = await fetch(`${MAIL_SINK_URL}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
  const body = (await res.json()) as { messages?: { Subject: string }[] };

  return (body.messages ?? []).map((message) => message.Subject);
};

const taskRowId = (cacheKey: string, jobId: string) =>
  `task-${createHash('sha256').update(cacheKey).digest('hex')}--${jobId}`;

test.describe('[RESILIENCE-4] a signed copy that could not be emailed', () => {
  test.describe.configure({ timeout: 180_000 });

  test('the owner is told, and the audit log names the recipient, as for a signing request', async ({
    request,
    page,
  }) => {
    const owner = await createOwner();
    const { envelopeId, envelope, documentId } = await createAndSend(request, owner, [uniqueEmail('nocopy')]);
    const [recipient] = envelope.recipients;

    await signAllFields(
      request,
      recipient.token,
      recipient.fields.map((field) => field.id),
    );
    expect((await completeWithToken(request, recipient.token, documentId)).ok()).toBeTruthy();
    expect(
      await waitFor(
        async () => (await prisma.envelope.findUniqueOrThrow({ where: { id: envelopeId } })).status === 'COMPLETED',
      ),
    ).toBe(true);

    // What a five-hour mail outage leaves: the completion emails on their last attempt, the
    // owner's copy sent, the recipient's copy tried and never sent.
    const job = await prisma.backgroundJob.create({
      data: {
        jobId: 'send.document.completed.emails',
        name: 'Send Document Completed Emails',
        version: '1.0.0',
        payload: { envelopeId },
        maxRetries: 5,
        retried: 5,
        nextRunAt: new Date(Date.now() - 1_000),
      },
    });
    await prisma.backgroundJobTask.createMany({
      data: [
        {
          id: taskRowId('send-owner-completed-email', job.id),
          name: 'send-owner-completed-email',
          jobId: job.id,
          status: 'COMPLETED',
          completedAt: new Date(),
        },
        {
          id: taskRowId(`send-completed-email-${recipient.id}`, job.id),
          name: `send-completed-email-${recipient.id}`,
          jobId: job.id,
          status: 'PENDING',
          retried: 5,
        },
      ],
    });

    const provider = await getProvider();
    expect((await provider.runRecovery({ jobIds: [job.id] })).failed).toEqual([job.id]);

    // Marked, as a failed signing request is.
    expect((await prisma.recipient.findUniqueOrThrow({ where: { id: recipient.id } })).deliveryFailedAt).not.toBeNull();

    const notDelivered = await prisma.documentAuditLog.findMany({ where: { envelopeId, type: 'EMAIL_NOT_DELIVERED' } });
    expect(notDelivered).toHaveLength(1);
    expect(notDelivered[0].data).toMatchObject({ recipientId: recipient.id, emailType: 'DOCUMENT_COMPLETED' });

    expect(
      await waitFor(async () => {
        const notice = await prisma.backgroundJob.findFirst({
          where: {
            jobId: 'send.solidten.notice.email',
            AND: [
              { payload: { path: ['kind'], equals: 'COMPLETED_DOCUMENT_NOT_DELIVERED' } },
              { payload: { path: ['envelopeId'], equals: envelopeId } },
            ],
          },
        });

        return notice?.status === 'COMPLETED';
      }),
    ).toBe(true);

    if (MAIL_SINK_URL) {
      expect(
        await waitFor(async () =>
          (await findMailSubjects(owner.user.email)).some((subject) =>
            subject.includes('the signed copy was not delivered'),
          ),
        ),
      ).toBe(true);
    }

    // The document page shows it on the recipient.
    await apiSignin({ page, email: owner.user.email, redirectPath: `/t/${owner.team.url}/documents/${envelopeId}` });
    await expect(page.getByTestId(`recipient-copy-not-delivered-${recipient.id}`)).toBeVisible({ timeout: 30_000 });
  });
});

test.describe('[RESILIENCE-4] LD4-L2 the count after a database outage', () => {
  test('an attempt cut off by an outage is given back; only the re-run that does the work is counted', async () => {
    // A lost job the sweep claimed (that attempt counted: retried 1), cut off during an outage.
    const job = await insertLostJob('internal.process-signing-reminder', { recipientId: 999_999_960 }, 10);
    await prisma.$executeRaw`UPDATE "BackgroundJob" SET "status" = 'PROCESSING', "retried" = 1, "updatedAt" = now() - interval '10 minutes' WHERE "id" = ${job.id}`;

    recordDatabaseWriteFailure();
    const provider = await getProvider();

    try {
      expect((await provider.runRecovery({ jobIds: [job.id] })).rescheduled).toEqual([job.id]);
    } finally {
      globalThis.__solidten_database_write_health__ = undefined;
    }

    expect((await prisma.backgroundJob.findUniqueOrThrow({ where: { id: job.id } })).retried).toBe(0);

    // The database is back: the job runs again, once, and that run is the one counted.
    await provider.runRecovery({ jobIds: [job.id], now: new Date(Date.now() + 2 * 60_000) });
    expect(
      await waitFor(
        async () => (await prisma.backgroundJob.findUniqueOrThrow({ where: { id: job.id } })).status === 'COMPLETED',
      ),
    ).toBe(true);
    expect((await prisma.backgroundJob.findUniqueOrThrow({ where: { id: job.id } })).retried).toBe(1);
  });
});
