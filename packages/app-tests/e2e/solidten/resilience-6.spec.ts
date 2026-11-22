import { execSync } from 'node:child_process';
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

import { apiSignin, WEBAPP_ORIGIN_HEADERS } from '../fixtures/authentication';

/**
 * Solid Ten: every signed copy is sent on its own and every lost copy is reported (F4-M1).
 */

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();
const apiUrl = `${WEBAPP_BASE_URL}/api/v2-beta`;

const examplePdf = fs.readFileSync(path.join(__dirname, '../../../../assets/example.pdf'));

const uniqueEmail = (tag: string) => `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@resilience.test`;

const createOwner = async (email?: string) => {
  const { user, team } = await seedUser({ email });

  const { token } = await createApiToken({
    userId: user.id,
    teamId: team.id,
    tokenName: 'resilience',
    expiresIn: null,
  });

  return { user, team, authHeaders: { Authorization: `Bearer ${token}` } };
};

type Owner = Awaited<ReturnType<typeof createOwner>>;

const MAIL_SINK_URL = process.env.E2E_MAIL_SINK_URL;
const MAIL_CONTAINER = process.env.E2E_MAIL_CONTAINER;
const REFUSED_DOMAIN = process.env.E2E_MAIL_REFUSED_DOMAIN;

const sleep = async (ms: number) => await new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (check: () => Promise<boolean>, timeoutMs = 60_000) => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await check()) {
      return true;
    }

    await sleep(500);
  }

  return false;
};

const mailDown = () => execSync(`docker stop ${MAIL_CONTAINER}`, { stdio: 'ignore' });

const mailUp = async () => {
  execSync(`docker start ${MAIL_CONTAINER}`, { stdio: 'ignore' });
  expect(
    await waitFor(async () => {
      try {
        return (await fetch(`${MAIL_SINK_URL}/api/v1/messages`)).ok;
      } catch {
        return false;
      }
    }, 30_000),
  ).toBe(true);
};

const completionMailsTo = async (to: string) => {
  const res = await fetch(`${MAIL_SINK_URL}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
  const body = (await res.json()) as { messages?: { Subject: string }[] };

  return (body.messages ?? []).filter((message) => message.Subject === 'Signing Complete!').length;
};

const getProvider = async () => {
  const { LocalJobProvider } = await import('@documenso/lib/jobs/client/local');

  return LocalJobProvider.getInstance();
};

/** Two signers and one CC; both signers sign; returns when the document is COMPLETED. */
const completeWithCc = async (request: APIRequestContext, owner: Owner) => {
  const signers = [uniqueEmail('sa'), uniqueEmail('sb')];
  const cc = uniqueEmail('cc');
  const payload: TCreateEnvelopePayload = {
    type: EnvelopeType.DOCUMENT,
    title: '[TEST] Copies',
    meta: { distributionMethod: 'EMAIL' },
    recipients: [
      ...signers.map((email, index) => ({
        email,
        name: `Signer ${index + 1}`,
        role: RecipientRole.SIGNER,
        fields: [
          {
            type: 'SIGNATURE' as const,
            page: 1,
            positionX: 10,
            positionY: 10 + index * 10,
            width: 10,
            height: 5,
            fieldMeta: { type: 'signature' as const },
          },
        ],
      })),
      { email: cc, name: 'Copy Reader', role: RecipientRole.CC },
    ],
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

  expect(
    (await request.post(`${apiUrl}/envelope/distribute`, { headers: owner.authHeaders, data: { envelopeId } })).ok(),
  ).toBeTruthy();

  const envelope = await prisma.envelope.findUniqueOrThrow({
    where: { id: envelopeId },
    include: { recipients: { include: { fields: true } } },
  });
  const documentId = Number(envelope.secondaryId.split('_').pop());

  return {
    envelopeId,
    documentId,
    recipients: envelope.recipients,
    complete: async () => {
      for (const recipient of envelope.recipients.filter((r) => r.role === RecipientRole.SIGNER)) {
        for (const field of recipient.fields) {
          const res = await request.post(`${WEBAPP_BASE_URL}/api/trpc/envelope.field.sign`, {
            headers: { ...WEBAPP_ORIGIN_HEADERS, 'content-type': 'application/json' },
            data: JSON.stringify({
              json: {
                token: recipient.token,
                fieldId: field.id,
                fieldValue: { type: 'SIGNATURE', value: 'Copy Signer' },
              },
            }),
          });
          expect(res.ok(), await res.text()).toBeTruthy();
        }

        const done = await request.post(`${WEBAPP_BASE_URL}/api/trpc/recipient.completeDocumentWithToken`, {
          headers: { ...WEBAPP_ORIGIN_HEADERS, 'content-type': 'application/json' },
          data: JSON.stringify({ json: { token: recipient.token, documentId } }),
        });
        expect(done.ok(), await done.text()).toBeTruthy();
      }

      expect(
        await waitFor(
          async () => (await prisma.envelope.findUniqueOrThrow({ where: { id: envelopeId } })).status === 'COMPLETED',
        ),
      ).toBe(true);
    },
  };
};

const completionJob = async (envelopeId: string) =>
  await prisma.backgroundJob.findFirst({
    where: { jobId: 'send.document.completed.emails', payload: { path: ['envelopeId'], equals: envelopeId } },
  });

/** Run the completion-email job's attempts now (the sweep, with time moved on) until it ends. */
const runAttempts = async (envelopeId: string, maxAttempts: number) => {
  const provider = await getProvider();

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const job = await completionJob(envelopeId);

    if (!job || job.status === 'COMPLETED' || job.status === 'FAILED') {
      return job;
    }

    if (job.status === 'PENDING') {
      await prisma.backgroundJob.update({ where: { id: job.id }, data: { nextRunAt: new Date(Date.now() - 1_000) } });
      await provider.runRecovery({ jobIds: [job.id], now: new Date(Date.now() + 10 * 60_000) });
    }

    await waitFor(async () => (await completionJob(envelopeId))?.status !== 'PROCESSING', 60_000);
    await sleep(500);
  }

  return await completionJob(envelopeId);
};

const notDelivered = async (envelopeId: string) =>
  (await prisma.documentAuditLog.findMany({ where: { envelopeId, type: 'EMAIL_NOT_DELIVERED' } })).map(
    (entry) => entry.data as { recipientEmail: string; recipientRole: string; emailType: string },
  );

test.describe('[RESILIENCE-6] F4-M1 the signed copies when mail fails', () => {
  test.describe.configure({ mode: 'serial', timeout: 600_000 });
  test.skip(
    !MAIL_CONTAINER || !MAIL_SINK_URL,
    'needs E2E_MAIL_CONTAINER (the mail sink container) and E2E_MAIL_SINK_URL',
  );

  test('mail down for the whole retry budget: every copy is reported, marked and badged', async ({ request, page }) => {
    const owner = await createOwner();
    const doc = await completeWithCc(request, owner);
    await sleep(3_000);

    mailDown();

    try {
      await doc.complete();
      expect(await waitFor(async () => (await completionJob(doc.envelopeId)) !== null)).toBe(true);
      expect((await runAttempts(doc.envelopeId, 12))?.status).toBe('FAILED');

      const entries = await notDelivered(doc.envelopeId);
      expect(entries.every((entry) => entry.emailType === 'DOCUMENT_COMPLETED')).toBe(true);
      expect(entries.map((entry) => entry.recipientEmail).sort()).toEqual(
        [owner.user.email, ...doc.recipients.map((recipient) => recipient.email)].sort(),
      );

      for (const recipient of doc.recipients) {
        expect(
          (await prisma.recipient.findUniqueOrThrow({ where: { id: recipient.id } })).deliveryFailedAt,
        ).not.toBeNull();
      }

      const notice = await prisma.backgroundJob.findFirst({
        where: {
          jobId: 'send.solidten.notice.email',
          AND: [
            { payload: { path: ['kind'], equals: 'COMPLETED_DOCUMENT_NOT_DELIVERED' } },
            { payload: { path: ['envelopeId'], equals: doc.envelopeId } },
          ],
        },
      });
      expect(
        (notice?.payload as { recipientIds: number[]; isOwnerCopyUndelivered: boolean })?.recipientIds.sort(),
      ).toEqual(doc.recipients.map((recipient) => recipient.id).sort());
      expect((notice?.payload as { isOwnerCopyUndelivered: boolean }).isOwnerCopyUndelivered).toBe(true);
    } finally {
      await mailUp();
    }

    await apiSignin({
      page,
      email: owner.user.email,
      redirectPath: `/t/${owner.team.url}/documents/${doc.envelopeId}`,
    });
    for (const recipient of doc.recipients) {
      await expect(page.getByTestId(`recipient-copy-not-delivered-${recipient.id}`)).toBeVisible({ timeout: 30_000 });
    }
  });

  test("only the owner's address refused: every other copy arrives once", async ({ request }) => {
    test.skip(
      !REFUSED_DOMAIN,
      'needs E2E_MAIL_REFUSED_DOMAIN: a domain the mail sink refuses (MP_SMTP_ALLOWED_RECIPIENTS)',
    );

    const owner = await createOwner(`owner-${Date.now()}@${REFUSED_DOMAIN}`);
    const doc = await completeWithCc(request, owner);
    await sleep(3_000);
    await doc.complete();

    expect(await waitFor(async () => (await completionJob(doc.envelopeId)) !== null)).toBe(true);
    expect((await runAttempts(doc.envelopeId, 12))?.status).toBe('FAILED');

    for (const recipient of doc.recipients) {
      expect(await completionMailsTo(recipient.email)).toBe(1);
    }

    const entries = await notDelivered(doc.envelopeId);
    expect(entries.map((entry) => `${entry.recipientRole} ${entry.recipientEmail}`)).toEqual([
      `OWNER ${owner.user.email}`,
    ]);
  });

  test('mail back in the middle of the budget: every copy exactly once, nothing reported', async ({ request }) => {
    const owner = await createOwner();
    const doc = await completeWithCc(request, owner);
    await sleep(3_000);

    mailDown();

    try {
      await doc.complete();
      expect(await waitFor(async () => (await completionJob(doc.envelopeId)) !== null)).toBe(true);
      // Two attempts fail.
      await runAttempts(doc.envelopeId, 2);
      expect((await completionJob(doc.envelopeId))?.status).toBe('PENDING');
    } finally {
      await mailUp();
    }

    expect((await runAttempts(doc.envelopeId, 6))?.status).toBe('COMPLETED');
    await sleep(2_000);

    for (const email of [owner.user.email, ...doc.recipients.map((recipient) => recipient.email)]) {
      expect(await completionMailsTo(email), email).toBe(1);
    }
    expect(await notDelivered(doc.envelopeId)).toEqual([]);
  });
});
