import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { jobs } from '@documenso/lib/jobs/client';
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

import { WEBAPP_ORIGIN_HEADERS } from '../fixtures/authentication';

/**
 * Solid Ten: failure-stress retest fixes, round 5 (FS2-M1, FS2-L1 to FS2-L6).
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

/** A BackgroundJob row as triggerJob leaves it when its POST to /api/jobs is lost. */
const insertLostJob = async (jobId: string, payload: Record<string, unknown>, ageMinutes = 5) => {
  const job = await prisma.backgroundJob.create({
    data: { jobId, name: jobId, version: '1.0.0', payload },
  });

  await prisma.$executeRaw`UPDATE "BackgroundJob" SET "updatedAt" = now() - (${ageMinutes} * interval '1 minute') WHERE "id" = ${job.id}`;

  return job;
};

const getProvider = async () => {
  const { LocalJobProvider } = await import('@documenso/lib/jobs/client/local');

  return LocalJobProvider.getInstance();
};

const sleep = async (ms: number) => await new Promise((resolve) => setTimeout(resolve, ms));

test.describe('[RESILIENCE-3] FS2-M1 a job the endpoint refuses is not re-submitted forever', () => {
  test.describe.configure({ timeout: 180_000 });

  test('a lost job whose payload the endpoint refuses ends FAILED within its attempt budget', async () => {
    // The endpoint answers 400 (payload schema) before it claims the row, as after a deploy that
    // changed a job's payload.
    const refused = await insertLostJob('internal.process-signing-reminder', { recipientId: 'not-a-number' });
    const provider = await getProvider();

    let sweeps = 0;

    for (let i = 1; i <= 10; i++) {
      const row = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: refused.id } });

      if (row.status === 'FAILED') {
        break;
      }

      // Each sweep looks a few minutes ahead, so the row counts as stale again.
      await provider.runRecovery({ jobIds: [refused.id], now: new Date(Date.now() + i * 5 * 60_000) });
      sweeps++;
      await sleep(1_500);
    }

    const row = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: refused.id } });

    expect(row.status).toBe('FAILED');
    expect(row.retried).toBe(row.maxRetries);
    expect(sweeps).toBeLessThanOrEqual(row.maxRetries + 1);
  });

  test('a lost job that runs is counted once per re-run, not twice', async () => {
    const lost = await insertLostJob('internal.process-signing-reminder', { recipientId: 999_999_999 });
    const provider = await getProvider();

    expect((await provider.runRecovery({ jobIds: [lost.id] })).resubmitted).toEqual([lost.id]);

    expect(
      await waitFor(async () => {
        const row = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: lost.id } });

        return row.status === 'COMPLETED';
      }),
    ).toBe(true);

    expect((await prisma.backgroundJob.findUniqueOrThrow({ where: { id: lost.id } })).retried).toBe(1);
  });
});

/** Sign every field of the only signer and complete; returns when the envelope is COMPLETED. */
const completeEnvelope = async (request: APIRequestContext, owner: Owner) => {
  const { envelopeId, envelope, documentId } = await createAndSend(request, owner, [uniqueEmail('seal')]);
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

  return { envelopeId, documentId };
};

const countJobs = async (jobId: string, path: string[], equals: string | number) =>
  await prisma.backgroundJob.count({ where: { jobId, payload: { path, equals } } });

test.describe('[RESILIENCE-3] FS2-L1 a seal re-run does not send its follow-ups again', () => {
  test.describe.configure({ timeout: 180_000 });

  test('a seal job re-run after its follow-ups were queued queues no second completion email or webhook', async ({
    request,
  }) => {
    const owner = await createOwner();

    const webhook = await prisma.webhook.create({
      data: {
        webhookUrl: 'http://127.0.0.1:9/fs2-l1',
        eventTriggers: ['DOCUMENT_COMPLETED'],
        enabled: true,
        userId: owner.user.id,
        teamId: owner.team.id,
      },
    });

    const { envelopeId, documentId } = await completeEnvelope(request, owner);

    const countWebhookJobs = async () =>
      await prisma.backgroundJob.count({
        where: {
          jobId: 'internal.execute-webhook',
          AND: [
            { payload: { path: ['webhookId'], equals: webhook.id } },
            { payload: { path: ['event'], equals: 'DOCUMENT_COMPLETED' } },
          ],
        },
      });

    expect(await waitFor(async () => (await countWebhookJobs()) === 1)).toBe(true);
    expect(
      await waitFor(async () => (await countJobs('send.document.completed.emails', ['envelopeId'], envelopeId)) === 1),
    ).toBe(true);

    // The process died after the seal queued its follow-ups, before the job row was marked done:
    // the row is left PROCESSING, the seal task itself is cached.
    const sealJob = await prisma.backgroundJob.findFirstOrThrow({
      where: { jobId: 'internal.seal-document', payload: { path: ['documentId'], equals: documentId } },
    });

    await prisma.$executeRaw`UPDATE "BackgroundJob" SET "status" = 'PENDING', "completedAt" = NULL, "updatedAt" = now() - interval '5 minutes' WHERE "id" = ${sealJob.id}`;

    const provider = await getProvider();
    expect((await provider.runRecovery({ jobIds: [sealJob.id] })).resubmitted).toEqual([sealJob.id]);

    expect(
      await waitFor(
        async () =>
          (await prisma.backgroundJob.findUniqueOrThrow({ where: { id: sealJob.id } })).status === 'COMPLETED',
      ),
    ).toBe(true);
    await sleep(3_000);

    expect(await countJobs('send.document.completed.emails', ['envelopeId'], envelopeId)).toBe(1);
    expect(await countWebhookJobs()).toBe(1);
    expect(await prisma.documentAuditLog.count({ where: { envelopeId, type: 'DOCUMENT_COMPLETED' } })).toBe(1);
  });
});

/** The BackgroundJobTask id the local provider gives a task (local.ts createJobRunIO). */
const taskRowId = (cacheKey: string, jobId: string) =>
  `task-${createHash('sha256').update(cacheKey).digest('hex')}--${jobId}`;

const reminderAudits = async (envelopeId: string, recipientId: number) =>
  await prisma.documentAuditLog.findMany({
    where: {
      envelopeId,
      type: 'EMAIL_SENT',
      AND: [
        { data: { path: ['emailType'], equals: 'REMINDER' } },
        { data: { path: ['recipientId'], equals: recipientId } },
      ],
    },
  });

const runLostReminder = async (recipientId: number) => {
  const job = await insertLostJob('internal.process-signing-reminder', { recipientId });
  const provider = await getProvider();

  expect((await provider.runRecovery({ jobIds: [job.id] })).resubmitted).toEqual([job.id]);
  expect(
    await waitFor(
      async () => (await prisma.backgroundJob.findUniqueOrThrow({ where: { id: job.id } })).status === 'COMPLETED',
    ),
  ).toBe(true);

  return job;
};

const sendOneSigner = async (request: APIRequestContext, tag: string) => {
  const owner = await createOwner();
  const { envelopeId, envelope } = await createAndSend(request, owner, [uniqueEmail(tag)]);
  const [recipient] = envelope.recipients;

  expect(
    await waitFor(
      async () => (await prisma.recipient.findUniqueOrThrow({ where: { id: recipient.id } })).sendStatus === 'SENT',
    ),
  ).toBe(true);

  return { envelopeId, recipient };
};

test.describe('[RESILIENCE-3] FS2-L2 reminder audit entry and count after a crash', () => {
  test.describe.configure({ timeout: 180_000 });

  test('a reminder cut off during its send gets an audit entry that says it may have been sent', async ({
    request,
  }) => {
    const { envelopeId, recipient } = await sendOneSigner(request, 'cutsend');

    // State a crash during the SMTP call leaves: the claim done, the send task marked "sending".
    const claimedAt = new Date(Date.now() - 3 * 60_000);
    await prisma.recipient.update({
      where: { id: recipient.id },
      data: {
        lastReminderSentAt: claimedAt,
        nextReminderAt: new Date(claimedAt.getTime() + 15 * 60_000),
        reminderCount: 1,
      },
    });

    const job = await insertLostJob('internal.process-signing-reminder', { recipientId: recipient.id });

    await prisma.backgroundJobTask.createMany({
      data: [
        {
          id: taskRowId('claim-reminder', job.id),
          name: 'claim-reminder',
          jobId: job.id,
          status: 'COMPLETED',
          result: { count: 1, claimedAt: claimedAt.toISOString() },
          completedAt: claimedAt,
        },
        {
          id: taskRowId('send-reminder', job.id),
          name: 'send-reminder',
          jobId: job.id,
          status: 'PENDING',
          result: { __solidtenStartedAt: claimedAt.toISOString() },
        },
      ],
    });

    const provider = await getProvider();
    expect((await provider.runRecovery({ jobIds: [job.id] })).resubmitted).toEqual([job.id]);
    expect(
      await waitFor(
        async () => (await prisma.backgroundJob.findUniqueOrThrow({ where: { id: job.id } })).status === 'COMPLETED',
      ),
    ).toBe(true);

    const audits = await reminderAudits(envelopeId, recipient.id);

    expect(audits).toHaveLength(1);
    expect(audits[0].data).toMatchObject({ deliveryUnconfirmed: true });
    expect((await prisma.recipient.findUniqueOrThrow({ where: { id: recipient.id } })).reminderCount).toBe(1);
  });

  test('a claim cut off before its task was recorded does not count a reminder that was never sent', async ({
    request,
  }) => {
    const { envelopeId, recipient } = await sendOneSigner(request, 'cutclaim');

    await prisma.recipient.update({
      where: { id: recipient.id },
      data: { nextReminderAt: new Date(Date.now() - 60_000) },
    });

    // A cut-off claim: its update commits, the write that records its task as done never lands.
    // A test-only trigger refuses that one write (for this job only); the job then fails, and its
    // retry finds the claim task not done and runs the claim again.
    const job = await insertLostJob('internal.process-signing-reminder', { recipientId: recipient.id });
    const fn = `st_test_cut_claim_${job.id}`;

    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION ${fn}() RETURNS trigger AS $$
      BEGIN
        IF NEW."jobId" = '${job.id}' AND NEW."name" = 'claim-reminder' AND NEW."status" = 'COMPLETED' THEN
          RAISE EXCEPTION 'simulated crash before the claim task was recorded';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER ${fn} BEFORE UPDATE ON "BackgroundJobTask" FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
    );

    try {
      const provider = await getProvider();
      expect((await provider.runRecovery({ jobIds: [job.id] })).resubmitted).toEqual([job.id]);

      // The retry finds the lease and stops; the trigger keeps refusing, so the job ends one way
      // or the other without a reminder.
      expect(
        await waitFor(async () =>
          ['COMPLETED', 'FAILED'].includes(
            (await prisma.backgroundJob.findUniqueOrThrow({ where: { id: job.id } })).status,
          ),
        ),
      ).toBe(true);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${fn} ON "BackgroundJobTask"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${fn}()`);
    }

    expect(await reminderAudits(envelopeId, recipient.id)).toHaveLength(0);

    // The lease ends and the reminder sweep claims the recipient again: one real reminder.
    await prisma.recipient.update({
      where: { id: recipient.id },
      data: { nextReminderAt: new Date(Date.now() - 60_000) },
    });
    await runLostReminder(recipient.id);

    expect(await reminderAudits(envelopeId, recipient.id)).toHaveLength(1);
    expect((await prisma.recipient.findUniqueOrThrow({ where: { id: recipient.id } })).reminderCount).toBe(1);
  });
});

test.describe('[RESILIENCE-3] FS2-L4 a create whose transaction runs out of time', () => {
  test.describe.configure({ timeout: 180_000 });

  test('answers 503 "busy, try again" without Prisma text and leaves nothing half created', async ({ request }) => {
    const owner = await createOwner();

    // Hold the team row longer than the create transaction may run (30 s): the envelope insert
    // waits on its foreign-key check, the transaction expires.
    let releaseLock: () => void = () => {};
    const lockHeld = new Promise<void>((resolve) => {
      void prisma
        .$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT "id" FROM "Team" WHERE "id" = ${owner.team.id} FOR UPDATE`;
            resolve();
            await new Promise<void>((release) => {
              releaseLock = release;
              setTimeout(release, 40_000);
            });
          },
          { timeout: 60_000, maxWait: 5_000 },
        )
        .catch(() => {});
    });
    await lockHeld;

    const formData = new FormData();
    formData.append(
      'payload',
      JSON.stringify({ type: EnvelopeType.DOCUMENT, title: '[TEST] Busy create', recipients: [] }),
    );
    formData.append('files', new File([examplePdf], 'example.pdf', { type: 'application/pdf' }));

    const res = await request.post(`${apiUrl}/envelope/create`, {
      headers: owner.authHeaders,
      multipart: formData,
      timeout: 120_000,
    });
    releaseLock();

    const text = await res.text();

    expect(res.status(), text).toBe(503);
    expect(res.headers()['retry-after']).toBeTruthy();
    expect(text).toContain('The server is busy, try again.');
    expect(text).not.toMatch(/prisma|Transaction|P2028|invocation/i);
    expect(await prisma.envelope.count({ where: { teamId: owner.team.id } })).toBe(0);
  });
});

/** Hold the team row for `ms`: creates for this team wait on their foreign-key check. */
const holdTeamRow = async (teamId: number, ms: number) => {
  let release: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });

  await new Promise<void>((locked) => {
    void prisma
      .$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "Team" WHERE "id" = ${teamId} FOR UPDATE`;
          locked();
          await Promise.race([done, sleep(ms)]);
        },
        { timeout: ms + 20_000, maxWait: 5_000 },
      )
      .catch(() => {});
  });

  return release;
};

test.describe('[RESILIENCE-3] FS2-L4 a create from a template rides out a stall', () => {
  test.describe.configure({ timeout: 180_000 });

  test('a document from a template is created when the database stalls 15 s', async ({ request }) => {
    const owner = await createOwner();
    const template = await seedTemplate({
      title: '[TEST] Busy template',
      userId: owner.user.id,
      teamId: owner.team.id,
      internalVersion: 2,
    });
    const [templateRecipient] = template.recipients;

    const release = await holdTeamRow(owner.team.id, 15_000);

    const res = await request.post(`${apiUrl}/template/use`, {
      headers: owner.authHeaders,
      data: {
        templateId: Number(template.secondaryId.split('_').pop()),
        recipients: [{ id: templateRecipient.id, email: uniqueEmail('tpl'), name: 'Template Signer' }],
      },
      timeout: 120_000,
    });
    release();

    expect(res.status(), await res.text()).toBe(200);
    expect(await prisma.envelope.count({ where: { teamId: owner.team.id, type: EnvelopeType.DOCUMENT } })).toBe(1);
  });
});

test.describe('[RESILIENCE-3] FS2-L6 a completion that never queued its seal', () => {
  test.describe.configure({ timeout: 180_000 });

  test('the recovery sweep seals a PENDING document whose signers all signed and that has no seal job', async ({
    request,
  }) => {
    const owner = await createOwner();
    const { envelopeId, envelope, documentId } = await createAndSend(request, owner, [uniqueEmail('noseal')]);
    const [recipient] = envelope.recipients;

    await signAllFields(
      request,
      recipient.token,
      recipient.fields.map((field) => field.id),
    );

    // What a completion that committed while the database restarted leaves: the signer SIGNED,
    // the envelope PENDING, no seal job.
    await prisma.recipient.update({
      where: { id: recipient.id },
      data: { signingStatus: 'SIGNED', signedAt: new Date(Date.now() - 5 * 60_000) },
    });
    expect(await countJobs('internal.seal-document', ['documentId'], documentId)).toBe(0);

    const provider = await getProvider();
    await provider.runRecovery();

    expect(
      await waitFor(
        async () => (await prisma.envelope.findUniqueOrThrow({ where: { id: envelopeId } })).status === 'COMPLETED',
      ),
    ).toBe(true);
    expect(await countJobs('internal.seal-document', ['documentId'], documentId)).toBe(1);

    // A second sweep queues nothing more.
    await provider.runRecovery();
    await sleep(2_000);
    expect(await countJobs('internal.seal-document', ['documentId'], documentId)).toBe(1);
    expect(await prisma.documentAuditLog.count({ where: { envelopeId, type: 'DOCUMENT_COMPLETED' } })).toBe(1);
  });
});

test.describe('[RESILIENCE-3] a reseal whose document was purged', () => {
  test.describe.configure({ timeout: 180_000 });

  test('ends quietly on its first attempt instead of failing until its budget is spent', async ({ request }) => {
    const owner = await createOwner();
    const { envelopeId, documentId } = await completeEnvelope(request, owner);

    // The retention purge removed the document (and with it its rows) before the reseal ran.
    await prisma.envelope.delete({ where: { id: envelopeId } });

    await jobs.triggerJob({ name: 'internal.seal-document', payload: { documentId, isResealing: true } });

    const findReseal = async () =>
      await prisma.backgroundJob.findFirst({
        where: {
          jobId: 'internal.seal-document',
          AND: [
            { payload: { path: ['documentId'], equals: documentId } },
            { payload: { path: ['isResealing'], equals: true } },
          ],
        },
      });

    expect(await waitFor(async () => (await findReseal())?.status === 'COMPLETED', 30_000)).toBe(true);
    expect((await findReseal())?.retried).toBe(0);
  });
});

test.describe('[RESILIENCE-3] FS2-L5 a crashed retention run', () => {
  test('is picked up by the recovery sweep after 10 minutes, not 30', async () => {
    const job = await prisma.backgroundJob.create({
      data: { jobId: 'internal.retention-sweep', name: 'internal.retention-sweep', version: '1.0.0', payload: {} },
    });

    // Cut off 11 minutes ago: the process died during the run.
    await prisma.$executeRaw`UPDATE "BackgroundJob" SET "status" = 'PROCESSING', "updatedAt" = now() - interval '11 minutes' WHERE "id" = ${job.id}`;

    const provider = await getProvider();
    const result = await provider.runRecovery({ jobIds: [job.id] });

    expect(result.rescheduled).toEqual([job.id]);

    // Do not leave a retention run behind for other tests.
    await prisma.backgroundJob.update({ where: { id: job.id }, data: { status: 'FAILED' } });
  });
});

test.describe('[RESILIENCE-3] FS2-L3 a lost job behind a backlog', () => {
  test('a fresh lost job is in the next sweep, also when older rows fill the batch', async () => {
    const backlog = await Promise.all(
      Array.from(
        { length: 6 },
        async () => await insertLostJob('internal.process-signing-reminder', { recipientId: 999_999_998 }, 60),
      ),
    );
    const fresh = await insertLostJob('internal.process-signing-reminder', { recipientId: 999_999_997 }, 3);

    const provider = await getProvider();
    const result = await provider.runRecovery({ jobIds: [...backlog.map((job) => job.id), fresh.id], batchSize: 4 });

    expect(result.resubmitted).toContain(fresh.id);
    expect(result.resubmitted).toHaveLength(4);
  });
});
