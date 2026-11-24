import fs from 'node:fs';
import path from 'node:path';
import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { createApiToken } from '@documenso/lib/server-only/public-api/create-api-token';
import { getBucket, parseWindow } from '@documenso/lib/server-only/rate-limit/rate-limit';
import { createPublicFormOpenedToken } from '@documenso/lib/utils/public-form';
import { formatDirectTemplatePath } from '@documenso/lib/utils/templates';
import { prisma } from '@documenso/prisma';
import { DocumentStatus, EnvelopeType, RecipientRole } from '@documenso/prisma/client';
import { seedDirectTemplate } from '@documenso/prisma/seed/templates';
import { seedUser } from '@documenso/prisma/seed/users';
import type {
  TCreateEnvelopePayload,
  TCreateEnvelopeResponse,
} from '@documenso/trpc/server/envelope-router/create-envelope.types';
import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { apiSignin, WEBAPP_ORIGIN_HEADERS } from '../fixtures/authentication';
import { getCanvasBox, getPageCanvas } from '../fixtures/contents';

/**
 * Solid Ten: fixes from the 11/21 load test (LD-M4, LD-M5, LD-L6, LD-L7).
 */

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();
const apiUrl = `${WEBAPP_BASE_URL}/api/v2-beta`;
const MAIL_SINK_URL = process.env.E2E_MAIL_SINK_URL;

const examplePdf = fs.readFileSync(path.join(__dirname, '../../../../assets/example.pdf'));

const uniqueEmail = (tag: string) => `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@load.test`;

const createOwner = async () => {
  const { user, team } = await seedUser();
  const { token } = await createApiToken({ userId: user.id, teamId: team.id, tokenName: 'load', expiresIn: null });

  return { user, team, authHeaders: { Authorization: `Bearer ${token}` } };
};

type Owner = Awaited<ReturnType<typeof createOwner>>;

const createAndSend = async (
  request: APIRequestContext,
  owner: Owner,
  signerEmail: string,
  {
    fieldCount = 1,
    fileCount = 1,
    fieldType = 'SIGNATURE',
  }: { fieldCount?: number; fileCount?: number; fieldType?: 'SIGNATURE' | 'NAME' } = {},
) => {
  const payload: TCreateEnvelopePayload = {
    type: EnvelopeType.DOCUMENT,
    title: '[TEST] Load',
    meta: { distributionMethod: 'EMAIL' },
    recipients: [
      {
        email: signerEmail,
        name: 'Load Signer',
        role: RecipientRole.SIGNER,
        fields: [
          ...Array.from({ length: fieldCount }, (_, index) => ({
            ...(fieldType === 'NAME'
              ? { type: 'NAME' as const, fieldMeta: { type: 'name' as const } }
              : { type: 'SIGNATURE' as const, fieldMeta: { type: 'signature' as const } }),
            page: 1,
            positionX: 5 + (index % 10) * 9,
            positionY: 5 + Math.floor(index / 10) * 4,
            width: 8,
            height: 3,
          })),
          // A signer needs a signature field; the NAME variant adds one at the bottom.
          ...(fieldType === 'NAME'
            ? [
                {
                  type: 'SIGNATURE' as const,
                  fieldMeta: { type: 'signature' as const },
                  page: 1,
                  positionX: 5,
                  positionY: 85,
                  width: 10,
                  height: 4,
                },
              ]
            : []),
        ],
      },
    ],
  };

  const formData = new FormData();
  formData.append('payload', JSON.stringify(payload));
  for (let index = 0; index < fileCount; index++) {
    formData.append('files', new File([examplePdf], `example-${index + 1}.pdf`, { type: 'application/pdf' }));
  }

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
    include: { recipients: { include: { fields: true } } },
  });

  return { envelopeId, envelope, documentId: Number(envelope.secondaryId.split('_').pop()) };
};

const trpcPost = async (request: APIRequestContext, route: string, json: Record<string, unknown>) =>
  await request.post(`${WEBAPP_BASE_URL}/api/trpc/${route}`, {
    headers: { ...WEBAPP_ORIGIN_HEADERS, 'content-type': 'application/json' },
    data: JSON.stringify({ json }),
  });

const signField = async (request: APIRequestContext, token: string, fieldId: number) =>
  await trpcPost(request, 'envelope.field.sign', {
    token,
    fieldId,
    fieldValue: { type: 'SIGNATURE', value: 'Load Signer' },
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

type MailSummary = { ID: string; Subject: string; Attachments: number };

const findMails = async (to: string) => {
  const res = await fetch(`${MAIL_SINK_URL}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
  const body = (await res.json()) as { messages?: MailSummary[] };

  return body.messages ?? [];
};

const getMailText = async (id: string) => {
  const res = await fetch(`${MAIL_SINK_URL}/api/v1/message/${id}`);

  return ((await res.json()) as { Text: string }).Text;
};

const completionAudits = async (envelopeId: string, recipientEmail: string) =>
  (
    await prisma.documentAuditLog.findMany({
      where: {
        envelopeId,
        type: 'EMAIL_SENT',
        AND: [
          { data: { path: ['emailType'], equals: 'DOCUMENT_COMPLETED' } },
          { data: { path: ['recipientEmail'], equals: recipientEmail } },
        ],
      },
      orderBy: { createdAt: 'asc' },
    })
  ).map((log) => (log.data as { documentDelivery?: string }).documentDelivery);

const BYTES_PER_MEGABYTE = 1024 * 1024;

/** The limit the app runs with: the tests and the app read the same .env. */
const attachmentLimitBytes = () => {
  const value = Number(process.env.NEXT_PRIVATE_ST_EMAIL_ATTACHMENT_LIMIT_MB);

  return (Number.isFinite(value) && value > 0 ? value : 7) * BYTES_PER_MEGABYTE;
};

/** Bytes of the signed files that the completion email would attach. */
const sealedBytes = async (envelopeId: string) => {
  const items = await prisma.envelopeItem.findMany({ where: { envelopeId }, include: { documentData: true } });

  return items.reduce((total, item) => total + Buffer.from(item.documentData.data, 'base64').byteLength, 0);
};

const completeOne = async (request: APIRequestContext, owner: Owner, fileCount: number) => {
  const signerEmail = uniqueEmail(`files${fileCount}`);
  const { envelopeId, envelope, documentId } = await createAndSend(request, owner, signerEmail, { fileCount });
  const [recipient] = envelope.recipients;

  for (const field of recipient.fields) {
    expect((await signField(request, recipient.token, field.id)).ok()).toBeTruthy();
  }

  const completeRes = await trpcPost(request, 'recipient.completeDocumentWithToken', {
    token: recipient.token,
    documentId,
  });
  expect(completeRes.ok(), await completeRes.text()).toBeTruthy();

  expect(
    await waitFor(async () => (await findMails(signerEmail)).some((mail) => mail.Subject === 'Signing Complete!')),
  ).toBe(true);

  return { envelopeId, signerEmail, token: recipient.token };
};

test.describe('[LOAD] LD-M5 a signed document too large for email goes as a link', () => {
  test.describe.configure({ timeout: 240_000 });

  test('files at or below the limit are attached; above it the email has a download link and no attachment', async ({
    request,
  }) => {
    test.skip(!MAIL_SINK_URL, 'needs E2E_MAIL_SINK_URL');

    const owner = await createOwner();
    const limit = attachmentLimitBytes();
    const forms = new Set<string>();

    // One file and two files: with NEXT_PRIVATE_ST_EMAIL_ATTACHMENT_LIMIT_MB=0.4 the first fits and the
    // second does not (each signed example is about 270 KB), so both forms are checked.
    for (const fileCount of [1, 2]) {
      const { envelopeId, signerEmail, token } = await completeOne(request, owner, fileCount);

      const completed = await prisma.envelope.findUniqueOrThrow({ where: { id: envelopeId } });
      expect(completed.status).toBe(DocumentStatus.COMPLETED);

      const expected = (await sealedBytes(envelopeId)) <= limit ? 'ATTACHMENT' : 'LINK';
      forms.add(expected);

      const [mail] = (await findMails(signerEmail)).filter((item) => item.Subject === 'Signing Complete!');
      const text = await getMailText(mail.ID);

      expect(await completionAudits(envelopeId, signerEmail)).toEqual([expected]);

      if (expected === 'ATTACHMENT') {
        expect(mail.Attachments).toBe(fileCount);
        expect(text).not.toContain('Download your signed document');
      } else {
        expect(mail.Attachments).toBe(0);
        expect(text).toContain('Download your signed document');
        expect(text).toContain(`/sign/${token}/complete`);

        // The link is the signer's download page, authorised by the link token.
        expect((await request.get(`${WEBAPP_BASE_URL}/sign/${token}/complete`)).ok()).toBeTruthy();
      }
    }

    console.log(`[LD-M5] attachment limit ${limit} bytes; forms checked: ${[...forms].join(', ')}`);
  });
});

const linkStatus = async (request: APIRequestContext, token: string) =>
  await request.get(
    `${WEBAPP_BASE_URL}/api/trpc/lifecycle.getSigningLinkStatus?input=${encodeURIComponent(JSON.stringify({ json: { token } }))}`,
    { headers: WEBAPP_ORIGIN_HEADERS },
  );

/** Spend one signing link's whole per-minute budget (600 calls). */
const exhaustLinkBudget = async (request: APIRequestContext, token: string) => {
  let lastStatus = 0;

  for (let round = 0; round < 70 && lastStatus !== 429; round++) {
    const responses = await Promise.all(Array.from({ length: 10 }, async () => await linkStatus(request, token)));
    lastStatus = responses.some((res) => res.status() === 429) ? 429 : 200;
  }

  return lastStatus;
};

/**
 * The limiter counts in fixed one-minute windows. Start a burst at the beginning of a window, so
 * the whole burst lands in one window (else 150 calls could split 80 / 70 and pass any limit).
 */
const waitForFreshMinute = async () => {
  const msIntoMinute = Date.now() % 60_000;

  if (msIntoMinute > 5_000) {
    await new Promise((resolve) => setTimeout(resolve, 60_000 - msIntoMinute + 200));
  }
};

const inBatches = async <T>(items: T[], size: number, run: (item: T) => Promise<boolean>) => {
  const failed: number[] = [];

  for (let start = 0; start < items.length; start += size) {
    const results = await Promise.all(items.slice(start, start + size).map(run));

    results.forEach((ok, offset) => {
      if (!ok) {
        failed.push(start + offset + 1);
      }
    });
  }

  return failed;
};

test.describe('[LOAD] LD-M4 signing calls have their own limit', () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });

  test('a signer with 150 fields signs them all within a minute', async ({ request }) => {
    const owner = await createOwner();
    const { envelope, documentId } = await createAndSend(request, owner, uniqueEmail('many'), { fieldCount: 150 });
    const [recipient] = envelope.recipients;

    await waitForFreshMinute();
    const started = Date.now();

    const refused = await inBatches(recipient.fields, 5, async (field) =>
      (await signField(request, recipient.token, field.id)).ok(),
    );

    expect(refused, `refused calls (1-based): ${refused.slice(0, 5).join(', ')}`).toEqual([]);
    expect(Date.now() - started).toBeLessThan(55_000);

    const completeRes = await trpcPost(request, 'recipient.completeDocumentWithToken', {
      token: recipient.token,
      documentId,
    });
    expect(completeRes.ok(), await completeRes.text()).toBeTruthy();
  });

  test('a signed-in user is counted per session, not per address', async ({ page }) => {
    const { user, team } = await seedUser();
    await apiSignin({ page, email: user.email, redirectPath: `/t/${team.url}/documents` });

    const url = `${WEBAPP_BASE_URL}/api/trpc/profile.findUserSecurityAuditLogs?input=${encodeURIComponent(JSON.stringify({ json: {} }))}`;

    await waitForFreshMinute();

    const refused = await inBatches(Array.from({ length: 150 }), 10, async () => {
      const res = await page.context().request.get(url, { headers: WEBAPP_ORIGIN_HEADERS });

      return res.status() === 200;
    });

    expect(refused, `refused calls (1-based): ${refused.slice(0, 5).join(', ')}`).toEqual([]);
  });

  test('one link over its budget gets a clear 429; another link and the raw token are unaffected', async ({
    request,
  }) => {
    test.skip(process.env.DANGEROUS_BYPASS_RATE_LIMITS === 'true', 'Rate limits are bypassed');

    const owner = await createOwner();
    const first = await createAndSend(request, owner, uniqueEmail('budget-a'));
    const second = await createAndSend(request, owner, uniqueEmail('budget-b'));
    const firstToken = first.envelope.recipients[0].token;
    const secondToken = second.envelope.recipients[0].token;

    expect(await exhaustLinkBudget(request, firstToken)).toBe(429);

    const limited = await linkStatus(request, firstToken);
    expect(limited.status()).toBe(429);
    expect(Number(limited.headers()['retry-after'])).toBeGreaterThan(0);

    const body = await limited.json();
    expect(body.error.json.data.code).toBe('TOO_MANY_REQUESTS');
    expect(body.error.json.message).toContain('Too many requests');

    // The other link, from the same address, still works.
    expect((await linkStatus(request, secondToken)).ok()).toBeTruthy();

    // Keys hold a hash of the link, never the link itself.
    const leaked = await prisma.rateLimit.count({
      where: { OR: [{ key: { contains: firstToken } }, { key: { contains: secondToken } }] },
    });
    expect(leaked).toBe(0);
  });

  test('the signing page says "Too many requests" when a sign call is refused and keeps the page', async ({
    page,
    request,
  }) => {
    // Test set-up (R): it needs real limits, like the 429 test above.
    test.skip(process.env.DANGEROUS_BYPASS_RATE_LIMITS === 'true', 'Rate limits are bypassed');

    const owner = await createOwner();
    const { envelope } = await createAndSend(request, owner, uniqueEmail('page'), {
      fieldCount: 2,
      fieldType: 'NAME',
    });
    const [recipient] = envelope.recipients;
    const [firstField, secondField] = recipient.fields.filter((field) => field.type === 'NAME');

    await openSigningPage(page, recipient.token);
    await clickField(page, firstField);

    expect(
      await waitFor(
        async () => (await prisma.field.findUniqueOrThrow({ where: { id: firstField.id } })).inserted,
        15_000,
      ),
    ).toBe(true);

    expect(await exhaustLinkBudget(request, recipient.token)).toBe(429);

    await clickField(page, secondField);

    await expect(page.getByText('Too many requests, wait a moment and try again.').first()).toBeVisible({
      timeout: 15_000,
    });

    // The earlier answer is kept and the page is still the signing page.
    expect((await prisma.field.findUniqueOrThrow({ where: { id: firstField.id } })).inserted).toBe(true);
    expect((await prisma.field.findUniqueOrThrow({ where: { id: secondField.id } })).inserted).toBe(false);
    await expect(getPageCanvas(page)).toBeVisible();
  });
});

const openSigningPage = async (page: Page, token: string) => {
  await page.goto(`/sign/${token}`);

  await expect(page.locator('img[data-page-number]').first()).toBeVisible({ timeout: 60_000 });
  await expect(getPageCanvas(page)).toBeVisible({ timeout: 60_000 });
};

const clickField = async (
  page: Page,
  field: { positionX: unknown; positionY: unknown; width: unknown; height: unknown },
) => {
  const canvasBox = await getCanvasBox(page);

  await getPageCanvas(page).click({
    position: {
      x: ((Number(field.positionX) + Number(field.width) / 2) / 100) * canvasBox.width,
      y: ((Number(field.positionY) + Number(field.height) / 2) / 100) * canvasBox.height,
    },
  });
};

let ipCounter = 1;

/** A test-only client address, so these limits do not touch other specs (the app reads x-forwarded-for). */
const nextIp = () => `203.0.${Math.floor(Math.random() * 250)}.${(ipCounter++ % 250) + 1}`;

const fillRateLimitBucket = async ({
  ip,
  action,
  window,
  count,
}: {
  ip: string;
  action: string;
  window: '1h' | '10m' | '15m';
  count: number;
}) => {
  const bucket = getBucket(parseWindow(window));

  await prisma.rateLimit.upsert({
    where: { key_action_bucket: { key: `ip:${ip}`, action, bucket } },
    create: { key: `ip:${ip}`, action, bucket, count },
    update: { count },
  });
};

test.describe('[LOAD] LD-L7 refusals carry the right code and Retry-After', () => {
  test('a rate-limited sign-in answers TOO_MANY_REQUESTS with a message and Retry-After', async ({ request }) => {
    test.skip(process.env.DANGEROUS_BYPASS_RATE_LIMITS === 'true', 'Rate limits are bypassed');

    const ip = nextIp();
    const email = uniqueEmail('signin');
    let response = null;

    for (let attempt = 0; attempt < 12; attempt++) {
      response = await request.post(`${WEBAPP_BASE_URL}/api/auth/email-password/authorize`, {
        headers: { ...WEBAPP_ORIGIN_HEADERS, 'x-forwarded-for': ip },
        data: { email, password: 'wrong-password', csrfToken: '' },
      });

      if (response.status() === 429) {
        break;
      }
    }

    expect(response?.status()).toBe(429);

    const body = await response?.json();
    expect(body.code).toBe('TOO_MANY_REQUESTS');
    expect(body.message).toContain('Too many requests');
    expect(Number(response?.headers()['retry-after'])).toBeGreaterThan(0);
  });

  test('a public form over its limit answers 429 with Retry-After, on the page and in tRPC', async ({ request }) => {
    test.skip(process.env.DANGEROUS_BYPASS_RATE_LIMITS === 'true', 'Rate limits are bypassed');

    const { user, team } = await seedUser();
    const seeded = await seedDirectTemplate({
      title: `Load form ${Date.now()}`,
      userId: user.id,
      teamId: team.id,
      internalVersion: 2,
    });

    if (!seeded.directLink) {
      throw new Error('Seeded template has no direct link');
    }

    const form = await prisma.stPublicForm.create({
      data: { directLinkId: seeded.directLink.id, requireVerifiedEmail: false },
    });

    const ip = nextIp();

    await fillRateLimitBucket({ ip, action: 'st.form.open', window: '10m', count: 60 });
    await fillRateLimitBucket({ ip, action: 'st.form.submit', window: '1h', count: 10 });

    const opened = await request.get(formatDirectTemplatePath(seeded.directLink.token), {
      headers: { 'x-forwarded-for': ip },
    });
    expect(opened.status()).toBe(429);
    expect(Number(opened.headers()['retry-after'])).toBeGreaterThan(0);

    const { updatedAt } = await prisma.envelope.findUniqueOrThrow({ where: { id: seeded.id } });
    const submitted = await request.post(`${WEBAPP_BASE_URL}/api/trpc/template.createDocumentFromDirectTemplate`, {
      headers: { ...WEBAPP_ORIGIN_HEADERS, 'content-type': 'application/json', 'x-forwarded-for': ip },
      data: JSON.stringify({
        json: {
          directTemplateToken: seeded.directLink.token,
          directRecipientEmail: uniqueEmail('form'),
          directRecipientName: 'Form Visitor',
          templateUpdatedAt: updatedAt.toISOString(),
          signedFieldValues: [{ fieldId: seeded.fields[0].id, value: 'Ann', token: '', isBase64: false }],
          publicForm: {
            openedToken: createPublicFormOpenedToken({
              key: process.env.NEXT_PRIVATE_ENCRYPTION_KEY ?? '',
              formId: form.id,
              now: new Date(Date.now() - 10_000),
            }),
            honeypot: '',
          },
        },
        meta: { values: { templateUpdatedAt: ['Date'] } },
      }),
    });

    expect(submitted.status()).toBe(429);
    expect(Number(submitted.headers()['retry-after'])).toBeGreaterThan(0);
  });

  test('ENVELOPE_ITEM_LIMIT_EXCEEDED answers BAD_REQUEST at the top level, with the specific code in data', async ({
    request,
  }) => {
    const owner = await createOwner();
    const organisation = await prisma.organisation.findFirstOrThrow({
      where: { teams: { some: { id: owner.team.id } } },
    });
    await prisma.organisationClaim.update({
      where: { id: organisation.organisationClaimId },
      data: { envelopeItemCount: 1 },
    });

    const formData = new FormData();
    formData.append(
      'payload',
      JSON.stringify({ type: EnvelopeType.DOCUMENT, title: '[TEST] Too many items', recipients: [] }),
    );
    formData.append('files', new File([examplePdf], 'one.pdf', { type: 'application/pdf' }));
    formData.append('files', new File([examplePdf], 'two.pdf', { type: 'application/pdf' }));

    const res = await request.post(`${apiUrl}/envelope/create`, { headers: owner.authHeaders, multipart: formData });

    expect(res.status()).toBe(400);

    const body = await res.json();
    expect(body.code).toBe('BAD_REQUEST');
    expect(body.data.code).toBe('ENVELOPE_ITEM_LIMIT_EXCEEDED');
  });
});

const getLocalProvider = async () => {
  const { LocalJobProvider } = await import('@documenso/lib/jobs/client/local');

  return LocalJobProvider.getInstance();
};

const minutesFromNow = (minutes: number) => new Date(Date.now() + minutes * 60_000);

/** A BackgroundJob row left PROCESSING by a process that died ten minutes ago. */
const insertCutOffJob = async (jobId: string, payload: Record<string, unknown>, maxRetries = 3) => {
  const job = await prisma.backgroundJob.create({
    data: { jobId, name: jobId, version: '1.0.0', payload, status: 'PROCESSING', maxRetries },
  });

  await prisma.$executeRaw`UPDATE "BackgroundJob" SET "updatedAt" = now() - interval '10 minutes' WHERE "id" = ${job.id}`;

  return job;
};

test.describe('[LOAD] LD2-B a job that takes the process down cannot crash-loop it', () => {
  test.describe.configure({ timeout: 240_000 });

  test('a cut-off completion-email job for a large stored PDF is recovered as a link, without loading the file', async ({
    request,
  }) => {
    test.skip(!MAIL_SINK_URL, 'needs E2E_MAIL_SINK_URL');

    const owner = await createOwner();
    const { envelopeId, signerEmail } = await completeOne(request, owner, 1);
    const mailsBefore = (await findMails(signerEmail)).filter((mail) => mail.Subject === 'Signing Complete!').length;

    // A stored document of about 9 MB that cannot even be decoded: if the job loaded it, the job would fail.
    const item = await prisma.envelopeItem.findFirstOrThrow({ where: { envelopeId } });
    await prisma.documentData.update({ where: { id: item.documentDataId }, data: { data: '!'.repeat(12_000_000) } });

    const job = await insertCutOffJob('send.document.completed.emails', { envelopeId }, 5);
    const provider = await getLocalProvider();

    expect((await provider.runRecovery({ jobIds: [job.id] })).rescheduled).toEqual([job.id]);
    expect((await provider.runRecovery({ jobIds: [job.id], now: minutesFromNow(2) })).resubmitted).toEqual([job.id]);

    expect(
      await waitFor(
        async () => (await prisma.backgroundJob.findUniqueOrThrow({ where: { id: job.id } })).status === 'COMPLETED',
      ),
    ).toBe(true);

    const mails = (await findMails(signerEmail)).filter((mail) => mail.Subject === 'Signing Complete!');
    expect(mails.length).toBe(mailsBefore + 1);

    const newest = mails[0];
    expect(newest.Attachments).toBe(0);
    expect(await getMailText(newest.ID)).toContain('Download your signed document');
  });

  test('a job that dies on every attempt waits longer each time and ends FAILED, never re-run at once', async () => {
    const provider = await getLocalProvider();
    const job = await insertCutOffJob('internal.cleanup-rate-limits', {}, 3);
    let clock = Date.now();
    const waits: number[] = [];

    for (let attempt = 1; attempt <= 3; attempt++) {
      const swept = await provider.runRecovery({ jobIds: [job.id], now: new Date(clock) });
      expect(swept.rescheduled, `attempt ${attempt}`).toEqual([job.id]);
      expect(swept.resubmitted).toEqual([]);

      const row = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(row.retried).toBe(attempt);
      waits.push(((row.nextRunAt?.getTime() ?? 0) - clock) / 60_000);

      // Just before its time it is not started.
      const early = await provider.runRecovery({
        jobIds: [job.id],
        now: new Date((row.nextRunAt?.getTime() ?? 0) - 1_000),
      });
      expect(early.resubmitted).toEqual([]);

      // It runs and the process dies again: PROCESSING, and found cut off after the timeout.
      await prisma.$executeRaw`UPDATE "BackgroundJob" SET "status" = 'PROCESSING', "nextRunAt" = NULL, "updatedAt" = now() WHERE "id" = ${job.id}`;
      clock = (row.nextRunAt?.getTime() ?? clock) + 6 * 60_000;
    }

    expect(waits).toEqual([1, 5, 15]);

    // The fourth cut-off spends the budget.
    const last = await provider.runRecovery({ jobIds: [job.id], now: new Date(clock) });
    expect(last.failed).toEqual([job.id]);
    expect((await prisma.backgroundJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('FAILED');
  });

  test('only one previously fatal job starts at a time', async () => {
    const provider = await getLocalProvider();
    const rows = await Promise.all(
      [1, 2].map(
        async () =>
          await prisma.backgroundJob.create({
            data: {
              jobId: 'internal.cleanup-rate-limits',
              name: 'cleanup',
              version: '1.0.0',
              payload: {},
              retried: 1,
              lastCrashedAt: new Date(),
              nextRunAt: new Date(Date.now() - 1_000),
            },
          }),
      ),
    );

    const swept = await provider.runRecovery({ jobIds: rows.map((row) => row.id) });
    expect(swept.resubmitted).toHaveLength(1);
  });
});

/** A 14 to 15 MB PDF (for example the load tester's scan17.pdf). The test is skipped without it. */
const LARGE_PDF_PATH = process.env.E2E_LARGE_PDF_PATH;

test.describe('[LOAD] LD2-A large uploads at the same time wait their turn', () => {
  test.describe.configure({ timeout: 600_000 });

  for (const parallel of [2, 3]) {
    test(`${parallel} concurrent creates of a 15 MB PDF all succeed or get a clean 503; nothing half-created`, async ({
      request,
    }) => {
      test.skip(!LARGE_PDF_PATH || !fs.existsSync(LARGE_PDF_PATH), 'set E2E_LARGE_PDF_PATH to a 14-15 MB PDF');

      const largePdf = fs.readFileSync(LARGE_PDF_PATH ?? '');
      const owner = await createOwner();
      const titles = Array.from({ length: parallel }, (_, index) => `[TEST] Large ${parallel}-${index} ${Date.now()}`);

      // Watch the app's heavy-PDF queue while the uploads run.
      let maxWaiting = 0;
      let wasBusySeen = false;
      let isWatching = true;

      const watcher = (async () => {
        while (isWatching) {
          const health = await request.get(`${WEBAPP_BASE_URL}/api/health`).catch(() => null);
          const body = health ? await health.json().catch(() => null) : null;

          maxWaiting = Math.max(maxWaiting, Number(body?.pdfQueue?.waiting ?? 0));
          wasBusySeen ||= body?.pdfQueue?.busy === true;

          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      })();

      const responses = await Promise.all(
        titles.map(async (title) => {
          const formData = new FormData();
          formData.append(
            'payload',
            JSON.stringify({ type: EnvelopeType.DOCUMENT, title, recipients: [] } satisfies TCreateEnvelopePayload),
          );
          formData.append('files', new File([largePdf], 'large.pdf', { type: 'application/pdf' }));

          const res = await request.post(`${apiUrl}/envelope/create`, {
            headers: owner.authHeaders,
            multipart: formData,
            timeout: 540_000,
          });

          return { title, status: res.status(), retryAfter: res.headers()['retry-after'], body: await res.text() };
        }),
      );

      isWatching = false;
      await watcher;

      // The uploads did not run side by side: the others waited their turn. /api/health is a
      // React Router route and the uploads run in the Hono/tRPC bundle: on a built server these
      // only hold when both read the same process-wide queue (RT4-L1).
      expect(wasBusySeen, 'heavy-PDF queue seen busy on /api/health').toBe(true);
      expect(maxWaiting, 'requests seen waiting in the heavy-PDF queue').toBeGreaterThanOrEqual(1);

      for (const response of responses) {
        expect([200, 503], `${response.status}: ${response.body.slice(0, 300)}`).toContain(response.status);
        expect(response.body).not.toContain('Transaction');

        const envelopes = await prisma.envelope.findMany({
          where: { title: response.title },
          include: { envelopeItems: true },
        });

        if (response.status === 200) {
          expect(envelopes).toHaveLength(1);
          expect(envelopes[0].envelopeItems).toHaveLength(1);
        } else {
          expect(Number(response.retryAfter)).toBeGreaterThan(0);
          expect(response.body).toContain('The server is busy');
          expect(envelopes).toHaveLength(0);
        }
      }

      // With a queue of four waiting places, two and three large creates all go through.
      expect(responses.filter((response) => response.status === 200)).toHaveLength(parallel);
    });
  }
});

test.describe('[LOAD] LD2-A a full heavy-PDF queue answers 503', () => {
  test.describe.configure({ timeout: 600_000 });

  test('eight large creates at once: one runs, four wait, the rest get 503 SERVICE_UNAVAILABLE with Retry-After and nothing is created for them', async ({
    request,
  }) => {
    test.skip(!LARGE_PDF_PATH || !fs.existsSync(LARGE_PDF_PATH), 'set E2E_LARGE_PDF_PATH to a 14-15 MB PDF');

    const largePdf = fs.readFileSync(LARGE_PDF_PATH ?? '');
    const owner = await createOwner();
    const titles = Array.from({ length: 8 }, (_, index) => `[TEST] Overflow ${index} ${Date.now()}`);

    const responses = await Promise.all(
      titles.map(async (title) => {
        const formData = new FormData();
        formData.append(
          'payload',
          JSON.stringify({ type: EnvelopeType.DOCUMENT, title, recipients: [] } satisfies TCreateEnvelopePayload),
        );
        formData.append('files', new File([largePdf], 'large.pdf', { type: 'application/pdf' }));

        const res = await request.post(`${apiUrl}/envelope/create`, {
          headers: owner.authHeaders,
          multipart: formData,
          timeout: 540_000,
        });

        return { title, status: res.status(), retryAfter: res.headers()['retry-after'], body: await res.text() };
      }),
    );

    const busy = responses.filter((response) => response.status === 503);

    // One running and four waiting places: at least five go through, at least one is refused.
    expect(responses.filter((response) => response.status === 200).length).toBeGreaterThanOrEqual(5);
    expect(busy.length).toBeGreaterThanOrEqual(1);

    for (const response of responses) {
      expect([200, 503], response.body.slice(0, 300)).toContain(response.status);
    }

    for (const response of busy) {
      expect(Number(response.retryAfter)).toBeGreaterThan(0);
      expect(response.body).toContain('The server is busy');
      // RT4-L2: the top-level code matches the 503.
      expect(JSON.parse(response.body).code).toBe('SERVICE_UNAVAILABLE');
      expect(response.body).not.toContain('Transaction');
      expect(await prisma.envelope.count({ where: { title: response.title } })).toBe(0);
    }
  });
});
