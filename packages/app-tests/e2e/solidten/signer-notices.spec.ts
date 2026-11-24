import fs from 'node:fs';
import path from 'node:path';
import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { jobs } from '@documenso/lib/jobs/client';
import { createApiToken } from '@documenso/lib/server-only/public-api/create-api-token';
import { prisma } from '@documenso/prisma';
import { DocumentStatus, EnvelopeType, RecipientRole } from '@documenso/prisma/client';
import { seedPendingDocument } from '@documenso/prisma/seed/documents';
import { seedUser } from '@documenso/prisma/seed/users';
import type {
  TCreateEnvelopePayload,
  TCreateEnvelopeResponse,
} from '@documenso/trpc/server/envelope-router/create-envelope.types';
import { type APIRequestContext, expect, test } from '@playwright/test';

const baseUrl = `${NEXT_PUBLIC_WEBAPP_URL()}/api/v2-beta`;

const examplePdf = fs.readFileSync(path.join(__dirname, '../../../../assets/example.pdf'));

test.describe.configure({ mode: 'parallel' });

const uniqueEmail = (label: string) =>
  `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.documenso.com`;

const createPendingViaApi = async (request: APIRequestContext) => {
  const { user, team } = await seedUser();

  const { token } = await createApiToken({ userId: user.id, teamId: team.id, tokenName: 'notices', expiresIn: null });
  const authHeaders = { Authorization: `Bearer ${token}` };

  const payload: TCreateEnvelopePayload = {
    type: EnvelopeType.DOCUMENT,
    title: '[TEST] Signer notices',
    recipients: [
      {
        email: uniqueEmail('signer'),
        name: 'Signer',
        role: RecipientRole.SIGNER,
        fields: [
          {
            type: 'SIGNATURE',
            page: 1,
            positionX: 10,
            positionY: 10,
            width: 10,
            height: 5,
            fieldMeta: { type: 'signature' },
          },
        ],
      },
    ],
  };

  const formData = new FormData();
  formData.append('payload', JSON.stringify(payload));
  formData.append('files', new File([examplePdf], 'example.pdf', { type: 'application/pdf' }));

  const createRes = await request.post(`${baseUrl}/envelope/create`, { headers: authHeaders, multipart: formData });
  expect(createRes.ok()).toBeTruthy();

  const { id: envelopeId }: TCreateEnvelopeResponse = await createRes.json();

  const distributeRes = await request.post(`${baseUrl}/envelope/distribute`, {
    headers: authHeaders,
    data: { envelopeId },
  });
  expect(distributeRes.ok()).toBeTruthy();

  const [recipient] = await prisma.recipient.findMany({ where: { envelopeId } });

  return { envelopeId, recipient, authHeaders };
};

test('[SIGNER_NOTICES]: a cancelled document shows a cancelled page instead of the signing page', async ({
  page,
  request,
}) => {
  const { envelopeId, recipient, authHeaders } = await createPendingViaApi(request);

  const cancelRes = await request.post(`${baseUrl}/envelope/cancel`, {
    headers: authHeaders,
    data: { envelopeId, reason: 'Wrong version' },
  });
  expect(cancelRes.ok(), await cancelRes.text()).toBeTruthy();

  await page.goto(`/sign/${recipient.token}`);

  await expect(page).toHaveURL(new RegExp(`/sign/${recipient.token}/cancelled$`));
  await expect(page.getByRole('heading', { name: 'This document was canceled' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reject Document' })).toHaveCount(0);

  // Opening a cancelled document is not recorded as the signer opening it.
  expect(await prisma.documentAuditLog.count({ where: { envelopeId, type: 'DOCUMENT_OPENED' } })).toBe(0);
});

test('[SIGNER_NOTICES]: the cancelled page also covers version-1 documents and is not reachable otherwise', async ({
  page,
}) => {
  const { user, team } = await seedUser();
  const legacy = await seedPendingDocument(user, team.id, [uniqueEmail('legacy')]);
  const [recipient] = legacy.recipients;

  // A pending document has no cancelled page.
  expect((await page.goto(`/sign/${recipient.token}/cancelled`))?.status()).toBe(404);

  await prisma.envelope.update({ where: { id: legacy.id }, data: { status: DocumentStatus.CANCELLED } });

  await page.goto(`/sign/${recipient.token}`);
  await expect(page).toHaveURL(new RegExp(`/sign/${recipient.token}/cancelled$`));
  await expect(page.getByRole('heading', { name: 'This document was canceled' })).toBeVisible();
});

/**
 * Optional Mailpit API receiving the app's SMTP (see .env.example).
 */
const MAIL_SINK_URL = process.env.E2E_MAIL_SINK_URL;

const findMailSubjects = async (to: string) => {
  const res = await fetch(`${MAIL_SINK_URL}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
  const body = (await res.json()) as { messages?: { Subject: string }[] };

  return (body.messages ?? []).map((message) => message.Subject);
};

/**
 * Let the signer's deadline pass and run the expiry job the sweep would queue.
 */
const expireAndProcess = async (recipientId: number) => {
  await prisma.recipient.update({ where: { id: recipientId }, data: { expiresAt: new Date(Date.now() - 60_000) } });

  await jobs.triggerJob({ name: 'internal.process-recipient-expired', payload: { recipientId } });

  await expect
    .poll(
      async () =>
        await prisma.backgroundJob.findFirst({
          where: {
            jobId: 'send.solidten.notice.email',
            AND: [
              { payload: { path: ['kind'], equals: 'SIGNER_DEADLINE_PASSED' } },
              { payload: { path: ['recipientId'], equals: recipientId } },
            ],
          },
          select: { status: true },
        }),
      { timeout: 30_000 },
    )
    .toMatchObject({ status: 'COMPLETED' });

  const job = await prisma.backgroundJob.findFirstOrThrow({
    where: {
      jobId: 'send.solidten.notice.email',
      AND: [
        { payload: { path: ['kind'], equals: 'SIGNER_DEADLINE_PASSED' } },
        { payload: { path: ['recipientId'], equals: recipientId } },
      ],
    },
  });

  // The step that hands the message to the mail server; absent when the notice is skipped.
  return await prisma.backgroundJobTask.findFirst({
    where: { jobId: job.id, name: 'send-solidten-notice-email', status: 'COMPLETED' },
  });
};

test('[SIGNER_NOTICES]: an expired signer is emailed that the deadline passed', async ({ request }) => {
  const { recipient } = await createPendingViaApi(request);

  expect(await expireAndProcess(recipient.id)).not.toBeNull();

  // With a mail catcher configured, also check the message that went out.
  if (MAIL_SINK_URL) {
    await expect
      .poll(async () => (await findMailSubjects(recipient.email)).join(' | '), { timeout: 30_000 })
      .toContain('The signing deadline for "[TEST] Signer notices" has passed');
  }
});

test('[SIGNER_NOTICES]: the deadline email follows the document setting for signing emails', async ({ request }) => {
  const { envelopeId, recipient } = await createPendingViaApi(request);

  await prisma.documentMeta.updateMany({
    where: { envelope: { id: envelopeId } },
    data: { emailSettings: { recipientSigningRequest: false } },
  });

  expect(await expireAndProcess(recipient.id)).toBeNull();
});

test('[SIGNER_NOTICES]: a signing page left open when the document is cancelled moves to the cancelled page', async ({
  page,
  request,
}) => {
  const { envelopeId, recipient, authHeaders } = await createPendingViaApi(request);

  await page.goto(`/sign/${recipient.token}`);
  await expect(page.getByRole('button', { name: 'Reject Document' })).toBeVisible();

  const cancelRes = await request.post(`${baseUrl}/envelope/cancel`, { headers: authHeaders, data: { envelopeId } });
  expect(cancelRes.ok()).toBeTruthy();

  // The page notices (when its next action fails, or when the tab regains focus) and
  // shows why; it may already have moved before the signer tries anything.
  try {
    await page.getByRole('button', { name: 'Reject Document' }).click({ timeout: 2_000 });
    await page.getByRole('dialog').getByRole('textbox').fill('too late', { timeout: 2_000 });
    await page.getByRole('dialog').getByRole('button', { name: 'Reject Document' }).click({ timeout: 2_000 });
  } catch {
    // Already redirected.
  }

  await expect(page).toHaveURL(new RegExp(`/sign/${recipient.token}/cancelled$`), { timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'This document was canceled' })).toBeVisible();
});
