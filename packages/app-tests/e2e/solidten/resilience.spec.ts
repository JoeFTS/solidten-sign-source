import fs from 'node:fs';
import path from 'node:path';
import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { jobs } from '@documenso/lib/jobs/client';
import { createApiToken } from '@documenso/lib/server-only/public-api/create-api-token';
import { prisma } from '@documenso/prisma';
import { DocumentStatus, EnvelopeType, RecipientRole, SigningStatus } from '@documenso/prisma/client';
import { seedUser } from '@documenso/prisma/seed/users';
import type {
  TCreateEnvelopePayload,
  TCreateEnvelopeResponse,
} from '@documenso/trpc/server/envelope-router/create-envelope.types';
import type { APIRequestContext } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { apiSignin, WEBAPP_ORIGIN_HEADERS } from '../fixtures/authentication';

/**
 * Solid Ten: failure-mode fixes from the 11/20 stress test (R-C1, R-H2, R-H5, R-M6).
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

const cancelViaApi = async (request: APIRequestContext, owner: Owner, envelopeId: string) =>
  await request.post(`${apiUrl}/envelope/cancel`, {
    headers: owner.authHeaders,
    data: { envelopeId, reason: 'race' },
  });

const countAuditLogs = async (envelopeId: string, type: string) =>
  await prisma.documentAuditLog.count({ where: { envelopeId, type } });

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

test.describe('[RESILIENCE] R-C1 cancel against the last signature', () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });

  test('cancel and the last signature at the same instant have exactly one winner', async ({ request }) => {
    const owner = await createOwner();
    const ROUNDS = 12;

    const prepareRound = async () => {
      const sent = await createAndSend(request, owner, [uniqueEmail('cc')]);
      const [recipient] = sent.envelope.recipients;

      await signAllFields(
        request,
        recipient.token,
        recipient.fields.map((field) => field.id),
      );

      return { ...sent, token: recipient.token };
    };

    // More than 5 uploads at once get 503 SERVER_BUSY by design (AUD-2: one PDF child, 4
    // waiting), so the envelopes are made in groups of at most 4.
    const GROUP_SIZE = 4;
    const rounds: Array<Awaited<ReturnType<typeof prepareRound>>> = [];

    for (let start = 0; start < ROUNDS; start += GROUP_SIZE) {
      const size = Math.min(GROUP_SIZE, ROUNDS - start);

      rounds.push(...(await Promise.all(Array.from({ length: size }, prepareRound))));
    }

    const outcomes: Array<{ envelopeId: string; completeOk: boolean; cancelOk: boolean }> = [];

    for (const round of rounds) {
      const [completeRes, cancelRes] = await Promise.all([
        completeWithToken(request, round.token, round.documentId),
        cancelViaApi(request, owner, round.envelopeId),
      ]);

      outcomes.push({ envelopeId: round.envelopeId, completeOk: completeRes.ok(), cancelOk: cancelRes.ok() });
    }

    // One winner per round: never both, never neither.
    for (const outcome of outcomes) {
      expect(outcome.completeOk !== outcome.cancelOk, JSON.stringify(outcome)).toBe(true);
    }

    for (const outcome of outcomes) {
      if (outcome.cancelOk) {
        // Give a (wrongly) queued seal time to run, then check that nothing finished the envelope.
        await new Promise((resolve) => setTimeout(resolve, 1_000));

        const envelope = await prisma.envelope.findUniqueOrThrow({
          where: { id: outcome.envelopeId },
          include: { recipients: true },
        });

        expect(envelope.status).toBe(DocumentStatus.CANCELLED);
        expect(envelope.recipients[0].signingStatus).toBe(SigningStatus.NOT_SIGNED);
      } else {
        const isCompleted = await waitFor(async () => {
          const envelope = await prisma.envelope.findUniqueOrThrow({ where: { id: outcome.envelopeId } });

          return envelope.status === DocumentStatus.COMPLETED;
        });

        expect(isCompleted, `${outcome.envelopeId} was not sealed`).toBe(true);
      }

      // The evidence never shows both endings.
      const cancelled = await countAuditLogs(outcome.envelopeId, 'DOCUMENT_CANCELLED');
      const completed = await countAuditLogs(outcome.envelopeId, 'DOCUMENT_COMPLETED');

      expect(cancelled + completed, outcome.envelopeId).toBe(1);
    }
  });

  test('a fully signed document waiting for its seal cannot be cancelled or deleted', async ({ request }) => {
    const owner = await createOwner();
    const { envelopeId, envelope } = await createAndSend(request, owner, [uniqueEmail('await')]);

    // The state between the last signature and the seal (or a lost seal job).
    await prisma.recipient.updateMany({
      where: { envelopeId },
      data: { signingStatus: SigningStatus.SIGNED, signedAt: new Date() },
    });

    const cancelRes = await cancelViaApi(request, owner, envelopeId);
    expect(cancelRes.status()).toBe(400);
    expect(await cancelRes.text()).toContain('being finalised');

    const deleteRes = await request.post(`${apiUrl}/envelope/delete`, {
      headers: owner.authHeaders,
      data: { envelopeId },
    });
    expect(deleteRes.ok()).toBeFalsy();

    const after = await prisma.envelope.findUniqueOrThrow({ where: { id: envelope.id } });
    expect(after.status).toBe(DocumentStatus.PENDING);
    expect(await countAuditLogs(envelopeId, 'DOCUMENT_CANCELLED')).toBe(0);
  });

  test('a seal that finds the envelope cancelled stops without completing it', async ({ request }) => {
    const owner = await createOwner();
    const { envelopeId, envelope, documentId } = await createAndSend(request, owner, [uniqueEmail('late')]);
    const [recipient] = envelope.recipients;

    await signAllFields(
      request,
      recipient.token,
      recipient.fields.map((field) => field.id),
    );

    // Signed, then cancelled before the seal ran (the old race, or a seal job recovered late).
    await prisma.recipient.updateMany({
      where: { envelopeId },
      data: { signingStatus: SigningStatus.SIGNED, signedAt: new Date() },
    });
    await prisma.envelope.update({ where: { id: envelopeId }, data: { status: DocumentStatus.CANCELLED } });

    await jobs.triggerJob({ name: 'internal.seal-document', payload: { documentId } });

    const isDone = await waitFor(async () => {
      const job = await prisma.backgroundJob.findFirst({
        where: { jobId: 'internal.seal-document', payload: { path: ['documentId'], equals: documentId } },
      });

      return job?.status === 'COMPLETED' || job?.status === 'FAILED';
    });

    expect(isDone).toBe(true);

    const sealJob = await prisma.backgroundJob.findFirstOrThrow({
      where: { jobId: 'internal.seal-document', payload: { path: ['documentId'], equals: documentId } },
    });
    expect(sealJob.status).toBe('COMPLETED');

    const after = await prisma.envelope.findUniqueOrThrow({ where: { id: envelopeId } });
    expect(after.status).toBe(DocumentStatus.CANCELLED);
    expect(await countAuditLogs(envelopeId, 'DOCUMENT_COMPLETED')).toBe(0);
  });
});

const waitForRecipientSent = async (recipientId: number) =>
  await waitFor(async () => {
    const recipient = await prisma.recipient.findUniqueOrThrow({ where: { id: recipientId } });

    return recipient.sendStatus === 'SENT';
  });

const countReminderAudits = async (envelopeId: string, recipientId: number) =>
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

/** A BackgroundJob row as triggerJob leaves it when its POST to /api/jobs is lost. */
const insertLostJob = async (jobId: string, payload: Record<string, unknown>, ageMinutes = 5) => {
  const job = await prisma.backgroundJob.create({
    data: { jobId, name: jobId, version: '1.0.0', payload },
  });

  await prisma.$executeRaw`UPDATE "BackgroundJob" SET "updatedAt" = now() - (${ageMinutes} * interval '1 minute') WHERE "id" = ${job.id}`;

  return job;
};

test.describe('[RESILIENCE] R-H2 lost jobs are recovered and run once', () => {
  test.describe.configure({ timeout: 180_000 });

  test('a PENDING job whose POST was lost is re-run by the recovery sweep, once', async ({ request }) => {
    const owner = await createOwner();
    const { envelopeId, envelope } = await createAndSend(request, owner, [uniqueEmail('lost')]);
    const [recipient] = envelope.recipients;

    expect(await waitForRecipientSent(recipient.id)).toBe(true);

    await prisma.recipient.update({
      where: { id: recipient.id },
      data: { nextReminderAt: new Date(Date.now() - 60_000) },
    });

    const lostJob = await insertLostJob('internal.process-signing-reminder', { recipientId: recipient.id });

    const { LocalJobProvider } = await import('@documenso/lib/jobs/client/local');
    const provider = LocalJobProvider.getInstance();

    const first = await provider.runRecovery({ jobIds: [lostJob.id] });
    expect(first.resubmitted).toEqual([lostJob.id]);

    expect(
      await waitFor(async () => {
        const job = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: lostJob.id } });

        return job.status === 'COMPLETED';
      }),
    ).toBe(true);

    expect(await countReminderAudits(envelopeId, recipient.id)).toBe(1);

    // A second sweep finds nothing to do.
    const second = await provider.runRecovery({ jobIds: [lostJob.id] });
    expect(second.resubmitted).toEqual([]);
  });

  test('two reminder jobs for the same recipient send one reminder', async ({ request }) => {
    const owner = await createOwner();
    const { envelopeId, envelope } = await createAndSend(request, owner, [uniqueEmail('dup')]);
    const [recipient] = envelope.recipients;

    expect(await waitForRecipientSent(recipient.id)).toBe(true);

    await prisma.recipient.update({
      where: { id: recipient.id },
      data: { nextReminderAt: new Date(Date.now() - 60_000) },
    });

    // Two sweeps (or a sweep and a recovered job) queue the same reminder.
    await Promise.all([
      jobs.triggerJob({ name: 'internal.process-signing-reminder', payload: { recipientId: recipient.id } }),
      jobs.triggerJob({ name: 'internal.process-signing-reminder', payload: { recipientId: recipient.id } }),
    ]);

    expect(
      await waitFor(async () => {
        const open = await prisma.backgroundJob.count({
          where: {
            jobId: 'internal.process-signing-reminder',
            status: { in: ['PENDING', 'PROCESSING'] },
            payload: { path: ['recipientId'], equals: recipient.id },
          },
        });

        return open === 0;
      }),
    ).toBe(true);

    expect(await countReminderAudits(envelopeId, recipient.id)).toBe(1);
  });

  test('a PROCESSING job cut off mid-run is re-run after its timeout, and gives up when its budget is spent', async ({
    request,
  }) => {
    const owner = await createOwner();
    const { envelopeId, envelope } = await createAndSend(request, owner, [uniqueEmail('cut'), uniqueEmail('crash')]);
    const [cutRecipient, crashRecipient] = envelope.recipients;

    expect(await waitForRecipientSent(cutRecipient.id)).toBe(true);
    await prisma.recipient.updateMany({
      where: { id: { in: [cutRecipient.id, crashRecipient.id] } },
      data: { sendStatus: 'SENT', sentAt: new Date(), nextReminderAt: new Date(Date.now() - 60_000) },
    });

    // Cut off 10 minutes ago (crash, out of memory) on its first attempt.
    const cutJob = await insertLostJob('internal.process-signing-reminder', { recipientId: cutRecipient.id }, 10);
    // A job that crashed the process on every one of its 4 attempts.
    const crashJob = await insertLostJob('internal.process-signing-reminder', { recipientId: crashRecipient.id }, 10);

    await prisma.backgroundJob.updateMany({ where: { id: cutJob.id }, data: { status: 'PROCESSING' } });
    await prisma.backgroundJob.updateMany({ where: { id: crashJob.id }, data: { status: 'PROCESSING', retried: 3 } });
    await prisma.$executeRaw`UPDATE "BackgroundJob" SET "updatedAt" = now() - interval '10 minutes' WHERE "id" IN (${cutJob.id}, ${crashJob.id})`;

    const { LocalJobProvider } = await import('@documenso/lib/jobs/client/local');
    const provider = LocalJobProvider.getInstance();
    const result = await provider.runRecovery({ jobIds: [cutJob.id, crashJob.id] });

    // The cut-off attempt is counted at once and the re-run waits a minute (LD2-B).
    expect(result.rescheduled).toEqual([cutJob.id]);
    expect(result.resubmitted).toEqual([]);
    expect(result.failed).toEqual([crashJob.id]);

    const rescheduled = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: cutJob.id } });
    expect(rescheduled.retried).toBe(1);
    // Cut off once together with another row (FS3-M1): counted, not taken for a poison job.
    expect(rescheduled.cutOffCount).toBe(1);
    expect(rescheduled.lastCrashedAt).toBeNull();

    const later = await provider.runRecovery({ jobIds: [cutJob.id], now: new Date(Date.now() + 2 * 60_000) });
    expect(later.resubmitted).toEqual([cutJob.id]);

    expect(
      await waitFor(async () => {
        const job = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: cutJob.id } });

        return job.status === 'COMPLETED';
      }),
    ).toBe(true);

    expect(await countReminderAudits(envelopeId, cutRecipient.id)).toBe(1);
    expect((await prisma.backgroundJob.findUniqueOrThrow({ where: { id: crashJob.id } })).status).toBe('FAILED');
    expect(await countReminderAudits(envelopeId, crashRecipient.id)).toBe(0);
  });
});

const MAIL_SINK_URL = process.env.E2E_MAIL_SINK_URL;

const findMailSubjects = async (to: string) => {
  const res = await fetch(`${MAIL_SINK_URL}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
  const body = (await res.json()) as { messages?: { Subject: string }[] };

  return (body.messages ?? []).map((message) => message.Subject);
};

const getLocalProvider = async () => {
  const { LocalJobProvider } = await import('@documenso/lib/jobs/client/local');

  return LocalJobProvider.getInstance();
};

const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000);

test.describe('[RESILIENCE] R-H5 email that cannot be delivered', () => {
  test.describe.configure({ timeout: 180_000 });

  test('a failing email job waits 1, 5, 15, 60, 240 minutes between attempts, then gives up', async () => {
    // A signing email for a recipient that does not exist fails on every attempt.
    await jobs.triggerJob({
      name: 'send.signing.requested.email',
      payload: { userId: 1, documentId: 1, recipientId: 2_000_000_000 },
    });

    const findJob = async () =>
      await prisma.backgroundJob.findFirstOrThrow({
        where: { jobId: 'send.signing.requested.email', payload: { path: ['recipientId'], equals: 2_000_000_000 } },
        orderBy: { submittedAt: 'desc' },
      });

    const expectWaiting = async (retried: number, minutes: number) => {
      expect(
        await waitFor(async () => {
          const job = await findJob();

          return job.status === 'PENDING' && job.retried === retried && job.nextRunAt !== null;
        }),
      ).toBe(true);

      const job = await findJob();
      const waitMs = (job.nextRunAt?.getTime() ?? 0) - job.updatedAt.getTime();

      expect(job.maxRetries).toBe(5);
      expect(Math.round(waitMs / 60_000)).toBe(minutes);

      return job;
    };

    let job = await expectWaiting(0, 1);
    const provider = await getLocalProvider();

    // Not due yet: the sweep leaves it alone.
    expect((await provider.runRecovery({ jobIds: [job.id] })).resubmitted).toEqual([]);

    for (const [retried, minutes] of [
      [1, 5],
      [2, 15],
      [3, 60],
      [4, 240],
    ]) {
      const result = await provider.runRecovery({ jobIds: [job.id], now: inMinutes(minutes === 5 ? 2 : minutes * 2) });
      expect(result.resubmitted).toEqual([job.id]);
      job = await expectWaiting(retried, minutes);
    }

    // The last attempt fails for good.
    await provider.runRecovery({ jobIds: [job.id], now: inMinutes(500) });

    expect(await waitFor(async () => (await findJob()).status === 'FAILED')).toBe(true);
  });

  test('after the last attempt the recipient shows "Not delivered", the owner is told, and Resend sends a normal request', async ({
    page,
    request,
  }) => {
    const owner = await createOwner();
    const signerEmail = uniqueEmail('undelivered');
    const { envelopeId, envelope, documentId } = await createAndSend(request, owner, [signerEmail]);
    const [recipient] = envelope.recipients;

    expect(await waitForRecipientSent(recipient.id)).toBe(true);

    // The state the mail outage left: never sent, and the signing email job on its last attempt.
    await prisma.recipient.update({ where: { id: recipient.id }, data: { sendStatus: 'NOT_SENT', sentAt: null } });

    const job = await prisma.backgroundJob.create({
      data: {
        jobId: 'send.signing.requested.email',
        name: 'Send Signing Email',
        version: '1.0.0',
        payload: { userId: owner.user.id, documentId, recipientId: recipient.id },
        maxRetries: 5,
        retried: 5,
        nextRunAt: new Date(Date.now() - 1_000),
      },
    });

    const provider = await getLocalProvider();
    const result = await provider.runRecovery({ jobIds: [job.id] });
    expect(result.failed).toEqual([job.id]);

    const marked = await prisma.recipient.findUniqueOrThrow({ where: { id: recipient.id } });
    expect(marked.deliveryFailedAt).not.toBeNull();
    expect(await countAuditLogs(envelopeId, 'EMAIL_NOT_DELIVERED')).toBe(1);

    // The API shows it.
    const apiRes = await request.get(`${apiUrl}/envelope/${envelopeId}`, { headers: owner.authHeaders });
    const apiEnvelope = await apiRes.json();
    expect(apiEnvelope.recipients[0].deliveryFailedAt).toBeTruthy();

    // The owner is told (an email job with the same retries).
    expect(
      await waitFor(async () => {
        const notice = await prisma.backgroundJob.findFirst({
          where: {
            jobId: 'send.solidten.notice.email',
            AND: [
              { payload: { path: ['kind'], equals: 'SIGNING_REQUEST_NOT_DELIVERED' } },
              { payload: { path: ['recipientId'], equals: recipient.id } },
            ],
          },
        });

        return notice?.status === 'COMPLETED';
      }),
    ).toBe(true);

    if (MAIL_SINK_URL) {
      expect(await findMailSubjects(owner.user.email)).toContainEqual(expect.stringContaining('was not delivered'));
    }

    // A second final failure does not repeat the entry or the notice.
    const again = await prisma.backgroundJob.create({
      data: {
        jobId: 'send.signing.requested.email',
        name: 'Send Signing Email',
        version: '1.0.0',
        payload: { userId: owner.user.id, documentId, recipientId: recipient.id },
        maxRetries: 5,
        retried: 5,
        nextRunAt: new Date(Date.now() - 1_000),
      },
    });
    await provider.runRecovery({ jobIds: [again.id] });
    expect(await countAuditLogs(envelopeId, 'EMAIL_NOT_DELIVERED')).toBe(1);

    // The document page shows the badge with a resend action.
    await apiSignin({ page, email: owner.user.email, redirectPath: `/t/${owner.team.url}/documents/${envelopeId}` });

    const badge = page.getByTestId(`recipient-not-delivered-${recipient.id}`);
    await expect(badge).toBeVisible({ timeout: 60_000 });
    await badge.hover();
    await page.getByTestId(`recipient-resend-${recipient.id}`).click();

    await expect(badge).not.toBeVisible({ timeout: 15_000 });

    const resent = await prisma.recipient.findUniqueOrThrow({ where: { id: recipient.id } });
    expect(resent.deliveryFailedAt).toBeNull();
    expect(resent.sendStatus).toBe('SENT');

    if (MAIL_SINK_URL) {
      const subjects = await findMailSubjects(signerEmail);
      // The first request and the resend; the resend is a normal request, not a reminder.
      expect(subjects.length).toBeGreaterThanOrEqual(2);
      expect(subjects.some((subject) => subject.startsWith('Reminder'))).toBe(false);
    }
  });

  test('a sign-in link that could not be mailed is mailed again a minute later', async () => {
    const { user } = await seedUser();
    const { scheduleSigninLinkRetry } = await import('@documenso/lib/jobs/client/schedule-delayed-job');

    await scheduleSigninLinkRetry({ email: user.email });

    const job = await prisma.backgroundJob.findFirstOrThrow({
      where: { jobId: 'send.solidten.signin.link.retry', payload: { path: ['email'], equals: user.email } },
    });

    expect(job.maxRetries).toBe(3);
    expect(job.nextRunAt?.getTime()).toBeGreaterThan(Date.now() + 30_000);

    const provider = await getLocalProvider();
    expect((await provider.runRecovery({ jobIds: [job.id] })).resubmitted).toEqual([]);
    expect((await provider.runRecovery({ jobIds: [job.id], now: inMinutes(2) })).resubmitted).toEqual([job.id]);

    expect(
      await waitFor(async () => {
        const row = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: job.id } });

        return row.status === 'COMPLETED';
      }),
    ).toBe(true);

    expect(await prisma.verificationToken.count({ where: { userId: user.id, identifier: 'email-link-signin' } })).toBe(
      1,
    );

    if (MAIL_SINK_URL) {
      expect(await findMailSubjects(user.email)).toContain('Your sign-in link');
    }
  });
});

test.describe('[RESILIENCE] R-M6 a send that failed half way heals itself', () => {
  test.describe.configure({ timeout: 120_000 });

  test('recipients left NOT_SENT with no email job get their signing request queued once', async ({ request }) => {
    const owner = await createOwner();
    const firstEmail = uniqueEmail('heal-a');
    const { envelopeId, envelope } = await createAndSend(request, owner, [firstEmail, uniqueEmail('heal-b')], {
      signingOrder: 'SEQUENTIAL',
    });
    const [first, second] = envelope.recipients;

    expect(await waitForRecipientSent(first.id)).toBe(true);

    // The state a send that failed after its commit leaves: DOCUMENT_SENT written, no email jobs.
    await prisma.backgroundJob.deleteMany({
      where: {
        jobId: 'send.signing.requested.email',
        payload: { path: ['recipientId'], equals: first.id },
      },
    });
    await prisma.recipient.update({ where: { id: first.id }, data: { sendStatus: 'NOT_SENT', sentAt: null } });

    const { healUnsentSigningRequests } = await import('@documenso/lib/jobs/client/heal-unsent-signing-requests');

    // A send in progress (DOCUMENT_SENT just written) is left alone.
    expect(await healUnsentSigningRequests({ envelopeIds: [envelopeId] })).toEqual([]);

    await prisma.documentAuditLog.updateMany({
      where: { envelopeId, type: 'DOCUMENT_SENT' },
      data: { createdAt: new Date(Date.now() - 10 * 60_000) },
    });

    // Only the signer whose turn it is (sequential order), and only once.
    expect(await healUnsentSigningRequests({ envelopeIds: [envelopeId] })).toEqual([first.id]);
    expect(await healUnsentSigningRequests({ envelopeIds: [envelopeId] })).toEqual([]);

    expect(await waitForRecipientSent(first.id)).toBe(true);

    const secondAfter = await prisma.recipient.findUniqueOrThrow({ where: { id: second.id } });
    expect(secondAfter.sendStatus).toBe('NOT_SENT');

    if (MAIL_SINK_URL) {
      expect((await findMailSubjects(firstEmail)).length).toBe(2);
    }
  });
});

test.describe('[RESILIENCE] health shows background job counts', () => {
  test('GET /api/health reports failed jobs, the oldest ready job and jobs waiting for a retry', async ({
    request,
  }) => {
    // Submitted an hour ago and never run; updatedAt is fresh, so the recovery sweep leaves it for now.
    const stuck = await prisma.backgroundJob.create({
      data: {
        jobId: 'internal.health-probe',
        name: 'health probe',
        version: '1',
        payload: {},
        submittedAt: new Date(Date.now() - 60 * 60_000),
      },
    });
    const waiting = await prisma.backgroundJob.create({
      data: {
        jobId: 'internal.health-probe',
        name: 'health probe',
        version: '1',
        payload: {},
        nextRunAt: new Date(Date.now() + 60 * 60_000),
      },
    });

    try {
      const res = await request.get(`${WEBAPP_BASE_URL}/api/health`);
      expect(res.ok()).toBeTruthy();

      const body = await res.json();

      expect(typeof body.jobs.failedLast24h).toBe('number');
      expect(body.jobs.oldestPendingAgeSeconds).toBeGreaterThanOrEqual(3_600);
      expect(body.jobs.waitingForRetry).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(body.jobs)).not.toContain(stuck.id);
    } finally {
      await prisma.backgroundJob.deleteMany({ where: { id: { in: [stuck.id, waiting.id] } } });
    }
  });
});
