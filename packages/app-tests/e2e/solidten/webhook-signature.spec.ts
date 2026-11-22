import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { jobs } from '@documenso/lib/jobs/client';
import { createApiToken } from '@documenso/lib/server-only/public-api/create-api-token';
import { prisma } from '@documenso/prisma';
import { seedUser } from '@documenso/prisma/seed/users';
import { expect, test } from '@playwright/test';
import { WebhookTriggerEvents } from '@prisma/client';

import { apiSignin, WEBAPP_ORIGIN_HEADERS } from '../fixtures/authentication';
import { expectTextToBeVisible } from '../fixtures/generic';

// These specs need the server started with NEXT_PRIVATE_WEBHOOK_SSRF_BYPASS_HOSTS=127.0.0.1, so it
// may call the receiver this test runs on the same machine.

type TReceived = { headers: http.IncomingHttpHeaders; body: string };

type TDocsVerifier = (options: {
  secret: string;
  rawBody: string;
  timestamp: string | undefined;
  signature: string | undefined;
  nowSeconds?: number;
}) => { valid: boolean; reason?: string };

const loadDocsVerifier = async (): Promise<TDocsVerifier> => {
  const file = path.resolve(__dirname, '../../../../docs/sign-integrations/examples/verify-signature.mjs');

  return (await import(pathToFileURL(file).href)).verifySolidTenWebhook;
};

const startReceiver = async (statuses: number[] = []) => {
  const received: TReceived[] = [];

  const server = http.createServer((req, res) => {
    let body = '';

    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      // Answer with the queued statuses in order, then 200.
      res.writeHead(statuses[received.length - 1] ?? 200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const { port } = server.address() as AddressInfo;

  return { url: `http://127.0.0.1:${port}/solidten`, received, close: () => server.close() };
};

const header = (headers: http.IncomingHttpHeaders, name: string) => {
  const value = headers[name];

  return Array.isArray(value) ? value[0] : value;
};

test.describe.configure({ mode: 'parallel' });

test('[WEBHOOK_SIGNATURE]: form accepts a bypassed private host, test event arrives signed and verifies', async ({
  page,
}) => {
  const receiver = await startReceiver();
  const verify = await loadDocsVerifier();
  const secret = `secret-${Date.now()}`;

  try {
    const { user, team } = await seedUser();

    await apiSignin({ page, email: user.email, redirectPath: `/t/${team.url}/settings/webhooks` });

    await page.getByRole('button', { name: 'Create Webhook' }).click();
    await page.getByLabel('Webhook URL*').fill(receiver.url);
    await page.getByLabel('Triggers').click();
    await page.getByText('document.completed').click();
    await page.getByText('The URL for Solid Ten Sign to send webhook events to.').click();
    await page.getByLabel('Secret').fill(secret);
    await page.getByRole('button', { name: 'Create' }).click();

    await expectTextToBeVisible(page, 'Webhook created');

    const webhook = await prisma.webhook.findFirstOrThrow({ where: { teamId: team.id } });

    expect(webhook.webhookUrl).toBe(receiver.url);

    await page.goto(`/t/${team.url}/settings/webhooks/${webhook.id}`);
    await page.getByRole('button', { name: 'Test', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Send' }).click();
    await expectTextToBeVisible(page, 'Test webhook queued');

    await expect.poll(() => receiver.received.length, { timeout: 20_000 }).toBe(1);

    const [delivery] = receiver.received;
    const timestamp = header(delivery.headers, 'x-solidten-timestamp');
    const signature = header(delivery.headers, 'x-solidten-signature');

    // Old header kept for compatibility.
    expect(header(delivery.headers, 'x-documenso-secret')).toBe(secret);
    expect(signature).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(JSON.parse(delivery.body).event).toBe(WebhookTriggerEvents.DOCUMENT_COMPLETED);

    expect(verify({ secret, rawBody: delivery.body, timestamp, signature })).toEqual({ valid: true });

    // Replay six minutes later: refused.
    expect(
      verify({ secret, rawBody: delivery.body, timestamp, signature, nowSeconds: Number(timestamp) + 360 }).valid,
    ).toBe(false);

    // Tampered body: refused.
    const tampered = delivery.body.replace('DOCUMENT_COMPLETED', 'DOCUMENT_CANCELLED');

    expect(tampered).not.toBe(delivery.body);
    expect(verify({ secret, rawBody: tampered, timestamp, signature }).valid).toBe(false);

    // Wrong secret: refused.
    expect(verify({ secret: 'not-the-secret', rawBody: delivery.body, timestamp, signature }).valid).toBe(false);

    // The delivery shows on the webhook page with its status.
    await expect
      .poll(async () => await prisma.webhookCall.count({ where: { webhookId: webhook.id, status: 'SUCCESS' } }))
      .toBe(1);

    await page.reload();
    await expect(page.getByRole('row').filter({ hasText: '200' }).first()).toBeVisible();
  } finally {
    receiver.close();
  }
});

test('[WEBHOOK_SIGNATURE]: a private host that is not on the bypass list is refused with the reason', async ({
  page,
}) => {
  const { user, team } = await seedUser();

  await apiSignin({ page, email: user.email, redirectPath: `/t/${team.url}/settings/webhooks` });

  await page.getByRole('button', { name: 'Create Webhook' }).click();
  await page.getByLabel('Webhook URL*').fill('http://10.0.0.13:5678/webhook');
  await page.getByLabel('Triggers').click();
  await page.getByText('document.completed').click();
  await page.getByText('The URL for Solid Ten Sign to send webhook events to.').click();
  await page.getByRole('button', { name: 'Create' }).click();

  // The form shows the server's reason, not a generic error.
  await expectTextToBeVisible(page, 'This address is on a private network.');

  expect(await prisma.webhook.count({ where: { teamId: team.id } })).toBe(0);
});

test('[WEBHOOK_SIGNATURE]: a webhook without a secret is delivered unsigned', async ({ page }) => {
  const receiver = await startReceiver();

  try {
    const { user, team } = await seedUser();

    const webhook = await prisma.webhook.create({
      data: {
        webhookUrl: receiver.url,
        eventTriggers: [WebhookTriggerEvents.DOCUMENT_COMPLETED],
        enabled: true,
        userId: user.id,
        teamId: team.id,
      },
    });

    await apiSignin({ page, email: user.email, redirectPath: `/t/${team.url}/settings/webhooks/${webhook.id}` });

    await page.getByRole('button', { name: 'Test', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Send' }).click();

    await expect.poll(() => receiver.received.length, { timeout: 20_000 }).toBe(1);

    expect(header(receiver.received[0].headers, 'x-solidten-signature')).toBeUndefined();
    expect(header(receiver.received[0].headers, 'x-solidten-timestamp')).toBeUndefined();
  } finally {
    receiver.close();
  }
});

const examplePdf = fs.readFileSync(path.join(__dirname, '../../../../assets/example.pdf'));

test('[WEBHOOK_SIGNATURE]: real event payloads and stored rows carry no recipient signing token', async ({
  request,
}) => {
  const receiver = await startReceiver();

  try {
    const { user, team } = await seedUser();

    await prisma.webhook.create({
      data: {
        webhookUrl: receiver.url,
        eventTriggers: [WebhookTriggerEvents.DOCUMENT_SENT],
        secret: 'token-test-secret',
        enabled: true,
        userId: user.id,
        teamId: team.id,
      },
    });

    const { token } = await createApiToken({ userId: user.id, teamId: team.id, tokenName: 'wh', expiresIn: null });
    const baseUrl = `${NEXT_PUBLIC_WEBAPP_URL()}/api/v2-beta`;

    const formData = new FormData();
    formData.append(
      'payload',
      JSON.stringify({
        type: 'DOCUMENT',
        title: 'Token leak check',
        recipients: [
          {
            email: 'token-leak@test.documenso.com',
            name: 'Signer',
            role: 'SIGNER',
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
      }),
    );
    formData.append('files', new File([examplePdf], 'example.pdf', { type: 'application/pdf' }));

    const createRes = await request.post(`${baseUrl}/envelope/create`, {
      headers: { Authorization: `Bearer ${token}` },
      multipart: formData,
    });
    const { id: envelopeId } = await createRes.json();

    const distributeRes = await request.post(`${baseUrl}/envelope/distribute`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { envelopeId },
    });

    expect(distributeRes.ok()).toBeTruthy();

    await expect.poll(() => receiver.received.length, { timeout: 20_000 }).toBe(1);

    const recipient = await prisma.recipient.findFirstOrThrow({ where: { envelopeId } });
    const delivered = JSON.parse(receiver.received[0].body);

    expect(delivered.event).toBe('DOCUMENT_SENT');
    expect(delivered.payload.recipients[0].email).toBe('token-leak@test.documenso.com');
    expect(delivered.payload.recipients[0]).not.toHaveProperty('token');
    expect(delivered.payload.Recipient[0]).not.toHaveProperty('token');
    expect(receiver.received[0].body).not.toContain(recipient.token);

    const call = await prisma.webhookCall.findFirstOrThrow({ where: { webhook: { teamId: team.id } } });

    expect(JSON.stringify(call.requestBody)).not.toContain(recipient.token);

    const job = await prisma.backgroundJob.findFirstOrThrow({
      where: { jobId: 'internal.execute-webhook', payload: { path: ['webhookId'], equals: call.webhookId } },
    });

    expect(JSON.stringify(job.payload)).not.toContain(recipient.token);
  } finally {
    receiver.close();
  }
});

test('[WEBHOOK_SIGNATURE]: a failed delivery is retried on a schedule, not at once', async ({ page }) => {
  // First answer 500, then 200.
  const receiver = await startReceiver([500]);

  try {
    const { user, team } = await seedUser();

    const webhook = await prisma.webhook.create({
      data: {
        webhookUrl: receiver.url,
        eventTriggers: [WebhookTriggerEvents.DOCUMENT_COMPLETED],
        secret: 'retry-secret',
        enabled: true,
        userId: user.id,
        teamId: team.id,
      },
    });

    await apiSignin({ page, email: user.email, redirectPath: `/t/${team.url}/settings/webhooks/${webhook.id}` });

    await page.getByRole('button', { name: 'Test', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Send' }).click();

    await expect.poll(() => receiver.received.length, { timeout: 20_000 }).toBe(1);

    await expect.poll(async () => await prisma.webhookCall.count({ where: { webhookId: webhook.id } })).toBe(1);

    const failed = await prisma.webhookCall.findFirstOrThrow({ where: { webhookId: webhook.id } });

    expect(failed).toMatchObject({ status: 'FAILED', responseCode: 500, attempt: 1 });
    const delayMs = (failed.nextAttemptAt?.getTime() ?? 0) - failed.createdAt.getTime();

    expect(delayMs).toBeGreaterThanOrEqual(55_000);
    expect(delayMs).toBeLessThanOrEqual(65_000);

    // The old behaviour retried four times within milliseconds. Give it time to show up if it still did.
    await page.waitForTimeout(3_000);
    expect(receiver.received.length).toBe(1);

    // Make the retry due and run the sweep, as the every-minute cron would.
    await prisma.webhookCall.update({ where: { id: failed.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    await jobs.triggerJob({ name: 'internal.retry-webhook-calls-sweep', payload: {} });

    await expect.poll(() => receiver.received.length, { timeout: 20_000 }).toBe(2);

    const timestamps = receiver.received.map((delivery) => header(delivery.headers, 'x-solidten-timestamp'));
    const verify = await loadDocsVerifier();

    expect(
      verify({
        secret: 'retry-secret',
        rawBody: receiver.received[1].body,
        timestamp: timestamps[1],
        signature: header(receiver.received[1].headers, 'x-solidten-signature'),
      }).valid,
    ).toBe(true);

    await expect
      .poll(async () =>
        (await prisma.webhookCall.findMany({ where: { webhookId: webhook.id }, orderBy: { createdAt: 'asc' } })).map(
          (call) => [call.status, call.attempt, call.nextAttemptAt === null],
        ),
      )
      .toEqual([
        ['FAILED', 1, true],
        ['SUCCESS', 2, true],
      ]);
  } finally {
    receiver.close();
  }
});

test('[WEBHOOK_SIGNATURE]: the last attempt is not scheduled again', async () => {
  const receiver = await startReceiver([500]);

  try {
    const { user, team } = await seedUser();

    const webhook = await prisma.webhook.create({
      data: {
        webhookUrl: receiver.url,
        eventTriggers: [WebhookTriggerEvents.DOCUMENT_COMPLETED],
        enabled: true,
        userId: user.id,
        teamId: team.id,
      },
    });

    await jobs.triggerJob({
      name: 'internal.execute-webhook',
      payload: { event: WebhookTriggerEvents.DOCUMENT_COMPLETED, webhookId: webhook.id, data: { id: 1 }, attempt: 6 },
    });

    await expect
      .poll(async () => await prisma.webhookCall.findFirst({ where: { webhookId: webhook.id } }), { timeout: 20_000 })
      .toMatchObject({ status: 'FAILED', attempt: 6, nextAttemptAt: null });
  } finally {
    receiver.close();
  }
});

test('[WEBHOOK_SIGNATURE]: editing a webhook to a refused host returns the reason and keeps the old URL', async ({
  page,
}) => {
  const { user, team } = await seedUser();

  const webhook = await prisma.webhook.create({
    data: {
      webhookUrl: 'https://example.com/hook',
      eventTriggers: [WebhookTriggerEvents.DOCUMENT_COMPLETED],
      enabled: true,
      userId: user.id,
      teamId: team.id,
    },
  });

  await apiSignin({ page, email: user.email });

  const res = await page.context().request.post(`${NEXT_PUBLIC_WEBAPP_URL()}/api/trpc/webhook.editWebhook`, {
    headers: { ...WEBAPP_ORIGIN_HEADERS, 'content-type': 'application/json', 'x-team-id': String(team.id) },
    data: JSON.stringify({
      json: {
        id: webhook.id,
        webhookUrl: 'http://100.64.10.20/hook',
        eventTriggers: [WebhookTriggerEvents.DOCUMENT_COMPLETED],
        secret: null,
        enabled: true,
      },
    }),
  });

  expect(res.status()).toBe(400);
  expect(JSON.stringify(await res.json())).toContain('This address is on a private network.');
  expect((await prisma.webhook.findUniqueOrThrow({ where: { id: webhook.id } })).webhookUrl).toBe(
    'https://example.com/hook',
  );
});

test('[WEBHOOK_SIGNATURE][S-L4]: a delivery refused by the address rule is final, with no retry', async ({ page }) => {
  const { user, team } = await seedUser();

  // Stored before the save-time check existed: a benchmarking-range address.
  const webhook = await prisma.webhook.create({
    data: {
      webhookUrl: 'http://198.18.0.1:5678/hook',
      eventTriggers: [WebhookTriggerEvents.DOCUMENT_COMPLETED],
      secret: 'refused-secret',
      enabled: true,
      userId: user.id,
      teamId: team.id,
    },
  });

  await apiSignin({ page, email: user.email, redirectPath: `/t/${team.url}/settings/webhooks/${webhook.id}` });

  await page.getByRole('button', { name: 'Test', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Send' }).click();

  await expect
    .poll(async () => await prisma.webhookCall.count({ where: { webhookId: webhook.id } }), {
      timeout: 20_000,
    })
    .toBe(1);

  const call = await prisma.webhookCall.findFirstOrThrow({ where: { webhookId: webhook.id } });
  expect(call).toMatchObject({ status: 'FAILED', attempt: 1, nextAttemptAt: null });

  // The sweep finds nothing to retry.
  await jobs.triggerJob({ name: 'internal.retry-webhook-calls-sweep', payload: {} });
  await page.waitForTimeout(3_000);
  expect(await prisma.webhookCall.count({ where: { webhookId: webhook.id } })).toBe(1);
});
