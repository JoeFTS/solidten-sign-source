import fs from 'node:fs';
import path from 'node:path';
import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { createApiToken } from '@documenso/lib/server-only/public-api/create-api-token';
import { claimDueScheduledSends } from '@documenso/lib/server-only/scheduled-send/claim-due-scheduled-sends';
import { executeScheduledSend } from '@documenso/lib/server-only/scheduled-send/execute-scheduled-send';
import { formatScheduledSendTime, SCHEDULED_SEND_STALE_CLAIM_MS } from '@documenso/lib/utils/scheduled-send';
import { prisma } from '@documenso/prisma';
import { DocumentStatus, EnvelopeType, RecipientRole } from '@documenso/prisma/client';
import { seedBlankDocument } from '@documenso/prisma/seed/documents';
import { seedUser } from '@documenso/prisma/seed/users';
import type {
  TCreateEnvelopePayload,
  TCreateEnvelopeResponse,
} from '@documenso/trpc/server/envelope-router/create-envelope.types';
import type { APIRequestContext } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { DateTime } from 'luxon';

import { apiSignin } from '../fixtures/authentication';
import { expectToastTextToBeVisible } from '../fixtures/generic';

const baseUrl = `${NEXT_PUBLIC_WEBAPP_URL()}/api/v2-beta`;

const examplePdf = fs.readFileSync(path.join(__dirname, '../../../../assets/example.pdf'));

test.describe.configure({ mode: 'parallel' });

const createDraftViaApi = async (request: APIRequestContext) => {
  const { user, team } = await seedUser();

  const { token } = await createApiToken({
    userId: user.id,
    teamId: team.id,
    tokenName: 'scheduled-send',
    expiresIn: null,
  });

  const payload: TCreateEnvelopePayload = {
    type: EnvelopeType.DOCUMENT,
    title: '[TEST] Scheduled send',
    recipients: [
      {
        email: `scheduled-${Date.now()}-${Math.random().toString(36).slice(2)}@test.documenso.com`,
        name: 'Scheduled Signer',
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

  const res = await request.post(`${baseUrl}/envelope/create`, {
    headers: { Authorization: `Bearer ${token}` },
    multipart: formData,
  });

  expect(res.ok()).toBeTruthy();

  const { id: envelopeId }: TCreateEnvelopeResponse = await res.json();

  const authHeaders = { Authorization: `Bearer ${token}` };

  const schedule = async (localDateTime: string, timezone = 'Etc/UTC') =>
    await request.post(`${baseUrl}/envelope/schedule-send`, {
      headers: authHeaders,
      data: { envelopeId, localDateTime, timezone },
    });

  return { user, team, envelopeId, authHeaders, schedule };
};

const inOneHour = (timezone = 'Etc/UTC') =>
  DateTime.now().setZone(timezone).plus({ hours: 1 }).toFormat("yyyy-MM-dd'T'HH:mm");

/**
 * Run the sweep as if it were two hours from now, scoped to this test's envelopes.
 * The rows stay in the future for the app's own cron sweep, so it cannot race the test.
 */
const sweepLater = async (...envelopeIds: string[]) =>
  await claimDueScheduledSends({ now: new Date(Date.now() + 2 * 3_600_000), envelopeIds });

/**
 * Move a scheduled send into the past so the app's cron sweep picks it up.
 */
const makeDue = async (envelopeId: string) => {
  await prisma.envelopeScheduledSend.update({
    where: { envelopeId },
    data: { scheduledAt: new Date(Date.now() - 60_000) },
  });
};

const countAuditLogs = async (envelopeId: string, type: string) =>
  await prisma.documentAuditLog.count({ where: { envelopeId, type } });

test('[SCHEDULED_SEND]: validates the time on the server and records who scheduled it', async ({ request }) => {
  const { envelopeId, schedule } = await createDraftViaApi(request);

  const pastRes = await schedule(DateTime.utc().minus({ minutes: 5 }).toFormat("yyyy-MM-dd'T'HH:mm"));
  expect(pastRes.status()).toBe(400);

  const farRes = await schedule(DateTime.utc().plus({ days: 400 }).toFormat("yyyy-MM-dd'T'HH:mm"));
  expect(farRes.status()).toBe(400);

  // 02:30 does not exist in New York on the spring-forward night.
  const nextGapYear = DateTime.utc().year + (DateTime.utc().month >= 3 ? 1 : 0);
  const gapDay = DateTime.fromObject({ year: nextGapYear, month: 3, day: 8 }, { zone: 'America/New_York' });
  const secondSunday = gapDay.plus({ days: (7 - gapDay.weekday) % 7 });

  const gapRes = await schedule(`${secondSunday.toFormat('yyyy-MM-dd')}T02:30`, 'America/New_York');
  expect(gapRes.status()).toBe(400);

  const badZoneRes = await schedule(inOneHour(), 'Mars/Olympus');
  expect(badZoneRes.status()).toBe(400);

  expect(await prisma.envelopeScheduledSend.count({ where: { envelopeId } })).toBe(0);

  const localTime = inOneHour('Asia/Tokyo');
  const okRes = await schedule(localTime, 'Asia/Tokyo');
  expect(okRes.ok()).toBeTruthy();

  const row = await prisma.envelopeScheduledSend.findUniqueOrThrow({ where: { envelopeId } });

  expect(row.status).toBe('SCHEDULED');
  expect(row.timezone).toBe('Asia/Tokyo');
  expect(DateTime.fromJSDate(row.scheduledAt).setZone('Asia/Tokyo').toFormat("yyyy-MM-dd'T'HH:mm")).toBe(localTime);

  const envelope = await prisma.envelope.findUniqueOrThrow({ where: { id: envelopeId } });
  expect(envelope.status).toBe(DocumentStatus.DRAFT);

  expect(await countAuditLogs(envelopeId, 'DOCUMENT_SEND_SCHEDULED')).toBe(1);
});

test('[SCHEDULED_SEND]: sender schedules from the send dialog and cancels from the editor', async ({
  page,
  request,
}) => {
  const { user, team, envelopeId } = await createDraftViaApi(request);

  await apiSignin({
    page,
    email: user.email,
    redirectPath: `/t/${team.url}/documents/${envelopeId}/edit`,
  });

  await page.locator('button[title="Send Envelope"]').click();
  await expect(page.getByRole('heading', { name: 'Send Document' })).toBeVisible();

  await page.getByTestId('schedule-send-fields').getByRole('switch').click();
  await expect(page.getByText(/Time zone:/)).toBeVisible();

  const localTime = DateTime.now().plus({ days: 2 }).set({ hour: 10, minute: 15 }).toFormat("yyyy-MM-dd'T'HH:mm");
  await page.locator('input[type="datetime-local"]').fill(localTime);

  await page.getByRole('button', { name: 'Schedule', exact: true }).click();
  await expectToastTextToBeVisible(page, 'Document scheduled');

  await expect.poll(async () => await prisma.envelopeScheduledSend.count({ where: { envelopeId } })).toBe(1);

  await page.goto(`/t/${team.url}/documents`);
  await expect(page.getByTestId('scheduled-send-badge').first()).toBeVisible();

  await page.goto(`/t/${team.url}/documents/${envelopeId}/edit`);
  await page.getByRole('button', { name: 'Scheduled send details' }).click();
  await page.getByRole('button', { name: 'Cancel schedule' }).click();
  await expectToastTextToBeVisible(page, 'Schedule removed');

  await expect.poll(async () => await prisma.envelopeScheduledSend.count({ where: { envelopeId } })).toBe(0);

  expect(await countAuditLogs(envelopeId, 'DOCUMENT_SEND_UNSCHEDULED')).toBe(1);

  const envelope = await prisma.envelope.findUniqueOrThrow({ where: { id: envelopeId } });
  expect(envelope.status).toBe(DocumentStatus.DRAFT);
});

test('[SCHEDULED_SEND]: concurrent sweeps claim a due send once and it is sent exactly once', async ({ request }) => {
  const { envelopeId, schedule } = await createDraftViaApi(request);

  expect((await schedule(inOneHour())).ok()).toBeTruthy();

  const [first, second, third] = await Promise.all([
    sweepLater(envelopeId),
    sweepLater(envelopeId),
    sweepLater(envelopeId),
  ]);

  const row = await prisma.envelopeScheduledSend.findUniqueOrThrow({ where: { envelopeId } });
  const claimsForRow = [...first, ...second, ...third].filter((claim) => claim.scheduledSendId === row.id);

  expect(claimsForRow).toHaveLength(1);
  expect(row.status).toBe('SENDING');
  expect(row.attempts).toBe(1);

  const results = await Promise.all([executeScheduledSend(claimsForRow[0]), executeScheduledSend(claimsForRow[0])]);

  expect(results).toContain('SENT');

  const envelope = await prisma.envelope.findUniqueOrThrow({ where: { id: envelopeId } });
  expect(envelope.status).toBe(DocumentStatus.PENDING);
  expect(await countAuditLogs(envelopeId, 'DOCUMENT_SENT')).toBe(1);

  const sentRow = await prisma.envelopeScheduledSend.findUniqueOrThrow({ where: { envelopeId } });
  expect(sentRow.status).toBe('SENT');

  expect(await sweepLater(envelopeId)).toHaveLength(0);
});

test('[SCHEDULED_SEND]: un-schedule and manual send lose cleanly to a claimed send', async ({ request }) => {
  const { envelopeId, schedule, authHeaders } = await createDraftViaApi(request);

  expect((await schedule(inOneHour())).ok()).toBeTruthy();

  const [claim] = await sweepLater(envelopeId);

  expect(claim).toBeDefined();

  const unscheduleRes = await request.post(`${baseUrl}/envelope/unschedule-send`, {
    headers: authHeaders,
    data: { envelopeId },
  });
  expect(unscheduleRes.ok()).toBeFalsy();
  expect(await unscheduleRes.text()).toContain('SCHEDULED_SEND_IN_PROGRESS');

  const distributeRes = await request.post(`${baseUrl}/envelope/distribute`, {
    headers: authHeaders,
    data: { envelopeId },
  });
  expect(distributeRes.ok()).toBeFalsy();
  expect(await distributeRes.text()).toContain('SCHEDULED_SEND_IN_PROGRESS');

  expect((await prisma.envelope.findUniqueOrThrow({ where: { id: envelopeId } })).status).toBe(DocumentStatus.DRAFT);

  expect(await executeScheduledSend(claim)).toBe('SENT');
  expect(await countAuditLogs(envelopeId, 'DOCUMENT_SENT')).toBe(1);
});

test('[SCHEDULED_SEND]: a manual send removes a waiting schedule', async ({ request }) => {
  const { envelopeId, schedule, authHeaders } = await createDraftViaApi(request);

  expect((await schedule(inOneHour())).ok()).toBeTruthy();

  const distributeRes = await request.post(`${baseUrl}/envelope/distribute`, {
    headers: authHeaders,
    data: { envelopeId },
  });
  expect(distributeRes.ok()).toBeTruthy();

  expect(await prisma.envelopeScheduledSend.count({ where: { envelopeId } })).toBe(0);

  const unscheduled = await prisma.documentAuditLog.findFirstOrThrow({
    where: { envelopeId, type: 'DOCUMENT_SEND_UNSCHEDULED' },
  });
  expect((unscheduled.data as Record<string, unknown>).reason).toBe('SENT_MANUALLY');
});

test('[SCHEDULED_SEND]: a send that fails is recorded, the owner is told, and it is not retried', async ({
  request,
}) => {
  const { user, envelopeId, schedule } = await createDraftViaApi(request);

  expect((await schedule(inOneHour())).ok()).toBeTruthy();

  await prisma.user.update({ where: { id: user.id }, data: { disabled: true } });

  const [claim] = await sweepLater(envelopeId);

  expect(await executeScheduledSend(claim)).toBe('FAILED');

  const failedRow = await prisma.envelopeScheduledSend.findUniqueOrThrow({ where: { envelopeId } });
  expect(failedRow.status).toBe('FAILED');
  expect(failedRow.lastError).toBeTruthy();

  expect(await countAuditLogs(envelopeId, 'DOCUMENT_SCHEDULED_SEND_FAILED')).toBe(1);
  expect((await prisma.envelope.findUniqueOrThrow({ where: { id: envelopeId } })).status).toBe(DocumentStatus.DRAFT);

  await expect
    .poll(async () =>
      prisma.backgroundJob.count({
        where: { jobId: 'send.solidten.notice.email', payload: { path: ['envelopeId'], equals: envelopeId } },
      }),
    )
    .toBe(1);

  expect(await sweepLater(envelopeId)).toHaveLength(0);
});

test('[SCHEDULED_SEND]: a claim lost to a restart is picked up again, and given up after three attempts', async ({
  request,
}) => {
  const first = await createDraftViaApi(request);
  const second = await createDraftViaApi(request);

  expect((await first.schedule(inOneHour())).ok()).toBeTruthy();
  expect((await second.schedule(inOneHour())).ok()).toBeTruthy();

  // Claimed by a worker that then died. The app's own cron sweep may also find
  // these rows, so the test checks the end state rather than who recovered them.
  const lostClaimedAt = new Date(Date.now() - SCHEDULED_SEND_STALE_CLAIM_MS - 60_000);

  await prisma.envelopeScheduledSend.update({
    where: { envelopeId: first.envelopeId },
    data: { status: 'SENDING', claimedAt: lostClaimedAt, attempts: 1 },
  });

  await prisma.envelopeScheduledSend.update({
    where: { envelopeId: second.envelopeId },
    data: { status: 'SENDING', claimedAt: lostClaimedAt, attempts: 3 },
  });

  // The old worker's claim is no longer honoured once anyone re-claims the row.
  const claims = await claimDueScheduledSends({ envelopeIds: [first.envelopeId, second.envelopeId] });

  for (const claim of claims) {
    expect(await executeScheduledSend(claim)).toBe('SENT');
  }

  expect(
    await executeScheduledSend({
      scheduledSendId: (
        await prisma.envelopeScheduledSend.findUniqueOrThrow({ where: { envelopeId: first.envelopeId } })
      ).id,
      claimedAt: lostClaimedAt.toISOString(),
    }),
  ).toBe('SKIPPED');

  await expect
    .poll(async () => (await prisma.envelope.findUniqueOrThrow({ where: { id: first.envelopeId } })).status, {
      timeout: 120_000,
    })
    .toBe(DocumentStatus.PENDING);

  const firstRow = await prisma.envelopeScheduledSend.findUniqueOrThrow({ where: { envelopeId: first.envelopeId } });
  expect(firstRow.attempts).toBe(2);
  await expect
    .poll(
      async () =>
        (await prisma.envelopeScheduledSend.findUniqueOrThrow({ where: { envelopeId: first.envelopeId } })).status,
    )
    .toBe('SENT');
  expect(await countAuditLogs(first.envelopeId, 'DOCUMENT_SENT')).toBe(1);

  const secondRow = await prisma.envelopeScheduledSend.findUniqueOrThrow({ where: { envelopeId: second.envelopeId } });
  expect(secondRow.status).toBe('FAILED');
  expect(await countAuditLogs(second.envelopeId, 'DOCUMENT_SCHEDULED_SEND_FAILED')).toBe(1);
  expect((await prisma.envelope.findUniqueOrThrow({ where: { id: second.envelopeId } })).status).toBe(
    DocumentStatus.DRAFT,
  );
});

test('[SCHEDULED_SEND]: the running app sends a due document on its own', async ({ request }) => {
  test.setTimeout(180_000);

  const { envelopeId, schedule } = await createDraftViaApi(request);

  expect((await schedule(inOneHour())).ok()).toBeTruthy();
  await makeDue(envelopeId);

  await expect
    .poll(async () => (await prisma.envelope.findUniqueOrThrow({ where: { id: envelopeId } })).status, {
      timeout: 150_000,
      intervals: [5_000],
    })
    .toBe(DocumentStatus.PENDING);

  await expect
    .poll(async () => (await prisma.envelopeScheduledSend.findUniqueOrThrow({ where: { envelopeId } })).status)
    .toBe('SENT');

  const sent = await prisma.documentAuditLog.findFirstOrThrow({ where: { envelopeId, type: 'DOCUMENT_SENT' } });
  expect(sent.userAgent).toBe('Solid Ten Sign scheduled send');
});

test.describe('[SCHEDULED_SEND]: a viewer in another timezone on a touch screen', () => {
  test.use({ timezoneId: 'Asia/Tokyo', hasTouch: true });

  test("sees the send time as text in their own timezone, and the sender's on tap", async ({ page, request }) => {
    const { user, team, envelopeId, schedule } = await createDraftViaApi(request);

    expect((await schedule(inOneHour('America/Los_Angeles'), 'America/Los_Angeles')).ok()).toBeTruthy();

    const row = await prisma.envelopeScheduledSend.findUniqueOrThrow({ where: { envelopeId } });
    const tokyoTime = `${formatScheduledSendTime(row.scheduledAt, 'Asia/Tokyo')} (Asia/Tokyo)`;
    const senderTime = `${formatScheduledSendTime(row.scheduledAt, 'America/Los_Angeles')} (America/Los_Angeles)`;

    await apiSignin({ page, email: user.email, redirectPath: `/t/${team.url}/documents` });

    await expect(page.getByTestId('scheduled-send-time').first()).toHaveText(tokyoTime);

    await page.goto(`/t/${team.url}/documents/${envelopeId}/edit`);
    await expect(page.getByTestId('scheduled-send-time')).toHaveText(tokyoTime);

    await page.getByRole('button', { name: 'Scheduled send details' }).tap();
    await expect(page.getByText(`The sender picked ${senderTime}.`)).toBeVisible();
  });
});

test('[SCHEDULED_SEND]: the documents list loads the schedules of all its drafts with one request', async ({
  page,
}) => {
  const { user, team } = await seedUser();

  const drafts = await Promise.all(
    Array.from(
      { length: 5 },
      async (_, index) =>
        await seedBlankDocument(user, team.id, { createDocumentOptions: { title: `Batch draft ${index}` } }),
    ),
  );

  for (const draft of drafts.slice(0, 2)) {
    await prisma.envelopeScheduledSend.create({
      data: {
        envelopeId: draft.id,
        scheduledAt: DateTime.now().plus({ days: 1 }).toJSDate(),
        timezone: 'Etc/UTC',
        userId: user.id,
      },
    });
  }

  // tRPC may batch several queries into one HTTP request, so count the procedure names.
  let scheduledSendQueries = 0;

  page.on('request', (request) => {
    const url = decodeURIComponent(request.url());

    if (url.includes('/api/trpc/')) {
      scheduledSendQueries += url.split('lifecycle.findScheduledSends').length - 1;
    }
  });

  await apiSignin({ page, email: user.email, redirectPath: `/t/${team.url}/documents` });

  await expect(page.getByTestId('scheduled-send-badge')).toHaveCount(2);
  await page.waitForLoadState('networkidle');

  expect(scheduledSendQueries).toBe(1);
});
