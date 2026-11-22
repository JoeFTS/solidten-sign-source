import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { markCompletedEmailsUndelivered } from '@documenso/lib/jobs/definitions/solidten/completed-email-delivery';
import {
  RESEND_COMPLETED_COPY_DAILY_MAX,
  RESEND_COMPLETED_COPY_QUOTA_ACTION,
} from '@documenso/lib/server-only/document/resend-completed-copy';
import { getDailyQuotaBucket } from '@documenso/lib/server-only/rate-limit/daily-quota';
import { applyRetentionToEnvelope } from '@documenso/lib/server-only/retention/apply-retention';
import type { TRetentionSettings } from '@documenso/lib/utils/retention';
import { prisma } from '@documenso/prisma';
import { DocumentStatus, Prisma } from '@documenso/prisma/client';
import { seedCompletedDocument, seedPendingDocument } from '@documenso/prisma/seed/documents';
import { seedUser } from '@documenso/prisma/seed/users';
import type { APIRequestContext } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { apiSignin, WEBAPP_ORIGIN_HEADERS } from '../fixtures/authentication';

/**
 * Solid Ten Sign, audit round G (owner decisions, 11/22):
 * G1 "Resend signed copy" on a recipient whose signed copy could not be emailed.
 * G2 a retention purge erases the document's audit-log rows and keeps one minimal record.
 */

test.describe.configure({ mode: 'parallel' });

const DAY = 24 * 60 * 60 * 1000;
const MAIL_SINK_URL = process.env.E2E_MAIL_SINK_URL;

const uniqueEmail = (label: string) =>
  `audit-g-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.documenso.com`;

const trpcPost = async (request: APIRequestContext, path: string, json: unknown, teamId: number) =>
  await request.post(`${NEXT_PUBLIC_WEBAPP_URL()}/api/trpc/${path}`, {
    headers: { ...WEBAPP_ORIGIN_HEADERS, 'content-type': 'application/json', 'x-team-id': String(teamId) },
    data: JSON.stringify({ json }),
  });

const resendSignedCopy = async (
  request: APIRequestContext,
  teamId: number,
  input: { envelopeId: string; recipientId: number },
) => await trpcPost(request, 'lifecycle.resendSignedCopy', input, teamId);

const errorMessage = async (response: Awaited<ReturnType<typeof trpcPost>>) => {
  const body = (await response.json()) as { error?: { json?: { message?: string } } };

  return body.error?.json?.message ?? '';
};

const waitFor = async (check: () => Promise<boolean>, timeoutMs = 60_000) => {
  const end = Date.now() + timeoutMs;

  while (Date.now() < end) {
    if (await check()) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return false;
};

/** A completed document whose signed copy to its one recipient was given up (as R-H5 leaves it). */
const seedUndeliveredCopy = async () => {
  const { user, team } = await seedUser();
  const signerEmail = uniqueEmail('signer');

  const document = await seedCompletedDocument(user, team.id, [signerEmail], {
    internalVersion: 2,
    createDocumentOptions: { completedAt: new Date(Date.now() - 60 * 60 * 1000) },
  });

  const signer = await prisma.recipient.findFirstOrThrow({ where: { envelopeId: document.id } });

  const recipient = await prisma.recipient.update({
    where: { id: signer.id },
    data: { deliveryFailedAt: new Date() },
  });

  return { user, team, document, recipient };
};

const completedEmailJobsFor = async (envelopeId: string) =>
  await prisma.backgroundJob.findMany({
    where: { jobId: 'send.document.completed.emails', payload: { path: ['envelopeId'], equals: envelopeId } },
  });

/* -------------------------------------------------------------------------- */
/*   G1: Resend signed copy                                                   */
/* -------------------------------------------------------------------------- */

test.describe('G1: Resend signed copy', () => {
  test.describe.configure({ timeout: 120_000 });

  test('the owner resends from the badge; the copy goes out, the badge goes, the audit log says who', async ({
    page,
  }) => {
    const { user, team, document, recipient } = await seedUndeliveredCopy();

    await apiSignin({ page, email: user.email, redirectPath: `/t/${team.url}/documents/${document.id}` });

    const badge = page.getByTestId(`recipient-copy-not-delivered-${recipient.id}`);
    await expect(badge).toBeVisible({ timeout: 30_000 });
    await badge.hover();
    await page.getByTestId(`recipient-resend-signed-copy-${recipient.id}`).click();
    await expect(page.getByText('Signed copy on its way').first()).toBeVisible();

    // Only this recipient's copy, through the completion email job.
    const [job] = await completedEmailJobsFor(document.id);
    expect(job.payload).toMatchObject({ envelopeId: document.id, resend: { recipientId: recipient.id } });

    expect(
      await waitFor(
        async () =>
          (await prisma.recipient.findUniqueOrThrow({ where: { id: recipient.id } })).deliveryFailedAt === null,
      ),
    ).toBe(true);

    const sent = await prisma.documentAuditLog.findMany({ where: { envelopeId: document.id, type: 'EMAIL_SENT' } });
    expect(sent).toHaveLength(1);
    expect(sent[0].data).toMatchObject({
      emailType: 'DOCUMENT_COMPLETED',
      recipientId: recipient.id,
      isResending: true,
    });
    expect(sent[0].userId).toBe(user.id);

    // The owner's own copy is not sent again.
    expect(JSON.stringify(sent)).not.toContain('"recipientRole":"OWNER"');

    if (MAIL_SINK_URL) {
      const res = await fetch(`${MAIL_SINK_URL}/api/v1/search?query=${encodeURIComponent(`to:"${recipient.email}"`)}`);
      const body = (await res.json()) as { messages?: { Subject: string }[] };
      expect((body.messages ?? []).map((message) => message.Subject)).toContain('Signing Complete!');
    }

    await page.reload();
    await expect(page.getByRole('heading', { name: document.title })).toBeVisible();
    await expect(badge).toHaveCount(0);
  });

  test('refused: not completed, another document, unverified address, someone else, in progress, too often', async ({
    page,
  }) => {
    const { user, team, document, recipient } = await seedUndeliveredCopy();

    await apiSignin({ page, email: user.email });
    const request = page.context().request;

    // Not completed.
    const pendingSigner = uniqueEmail('pending');
    const pending = await seedPendingDocument(user, team.id, [pendingSigner]);
    const pendingRecipient = await prisma.recipient.findFirstOrThrow({ where: { envelopeId: pending.id } });
    const notCompleted = await resendSignedCopy(request, team.id, {
      envelopeId: pending.id,
      recipientId: pendingRecipient.id,
    });
    expect(notCompleted.status()).toBe(400);
    expect(await errorMessage(notCompleted)).toBe('Only a completed document has a signed copy to send.');

    // A recipient of another document.
    const wrongRecipient = await resendSignedCopy(request, team.id, {
      envelopeId: document.id,
      recipientId: pendingRecipient.id,
    });
    expect(wrongRecipient.status()).toBe(404);

    // An address a visitor typed on a direct link: the same message as resend.
    await prisma.recipient.update({ where: { id: recipient.id }, data: { unverifiedEmailAt: new Date() } });
    const unverified = await resendSignedCopy(request, team.id, { envelopeId: document.id, recipientId: recipient.id });
    expect(unverified.status()).toBe(400);
    expect(await errorMessage(unverified)).toBe(
      'This address was typed by a visitor on a direct link and is not verified, so Solid Ten Sign does not send mail to it.',
    );
    await prisma.recipient.update({ where: { id: recipient.id }, data: { unverifiedEmailAt: null } });

    // The document's email settings do not send the copy.
    await prisma.documentMeta.update({
      where: { id: document.documentMetaId },
      data: {
        emailSettings: {
          recipientSigningRequest: true,
          recipientRemoved: true,
          recipientSigned: true,
          documentPending: true,
          documentCompleted: false,
          documentDeleted: true,
          ownerDocumentCompleted: true,
          ownerRecipientExpired: true,
          ownerDocumentCreated: true,
        },
      },
    });
    const settingsOff = await resendSignedCopy(request, team.id, {
      envelopeId: document.id,
      recipientId: recipient.id,
    });
    expect(settingsOff.status()).toBe(400);
    expect(await errorMessage(settingsOff)).toBe(
      'The email settings of this document do not send the signed copy to recipients.',
    );
    await prisma.documentMeta.update({
      where: { id: document.documentMetaId },
      data: { emailSettings: Prisma.DbNull },
    });

    // Someone who may not manage the document.
    const stranger = await seedUser();
    await apiSignin({ page, email: stranger.user.email });
    const notTheirs = await resendSignedCopy(page.context().request, stranger.team.id, {
      envelopeId: document.id,
      recipientId: recipient.id,
    });
    expect(notTheirs.ok()).toBe(false);
    expect(await completedEmailJobsFor(document.id)).toHaveLength(0);

    await apiSignin({ page, email: user.email });

    // A send of the copies still waiting for a retry: no second send.
    const waiting = await prisma.backgroundJob.create({
      data: {
        jobId: 'send.document.completed.emails',
        name: 'Send Document Completed Emails',
        version: '1.0.0',
        payload: { envelopeId: document.id },
        nextRunAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    const inProgress = await resendSignedCopy(page.context().request, team.id, {
      envelopeId: document.id,
      recipientId: recipient.id,
    });
    expect(inProgress.status()).toBe(400);
    expect(await errorMessage(inProgress)).toBe('The signed copy is still being sent. Try again later.');
    await prisma.backgroundJob.delete({ where: { id: waiting.id } });

    // Too often today for this recipient (a daily quota: holds also when rate limits are bypassed).
    await prisma.rateLimit.create({
      data: {
        key: `recipient:${recipient.id}`,
        action: RESEND_COMPLETED_COPY_QUOTA_ACTION,
        bucket: getDailyQuotaBucket(),
        count: RESEND_COMPLETED_COPY_DAILY_MAX,
      },
    });
    const tooOften = await resendSignedCopy(page.context().request, team.id, {
      envelopeId: document.id,
      recipientId: recipient.id,
    });
    expect(tooOften.status()).toBe(429);
    expect(await completedEmailJobsFor(document.id)).toHaveLength(0);

    // Nothing was cleared by any refusal.
    expect((await prisma.recipient.findUniqueOrThrow({ where: { id: recipient.id } })).deliveryFailedAt).not.toBeNull();
  });

  test('G1-D1: five requests at the same instant queue one job, use one quota unit, send one copy', async ({
    page,
  }) => {
    const { user, team, document, recipient } = await seedUndeliveredCopy();

    await apiSignin({ page, email: user.email });
    const request = page.context().request;

    const responses = await Promise.all(
      Array.from({ length: 5 }, async () =>
        resendSignedCopy(request, team.id, { envelopeId: document.id, recipientId: recipient.id }),
      ),
    );

    const statuses = responses.map((response) => response.status());
    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    expect(statuses.filter((status) => status === 400)).toHaveLength(4);

    for (const response of responses.filter((candidate) => candidate.status() === 400)) {
      expect(await errorMessage(response)).toBe('The signed copy is still being sent. Try again later.');
    }

    expect(await completedEmailJobsFor(document.id)).toHaveLength(1);

    const quota = await prisma.rateLimit.findMany({
      where: { action: RESEND_COMPLETED_COPY_QUOTA_ACTION, key: `recipient:${recipient.id}` },
    });
    expect(quota.reduce((sum, row) => sum + row.count, 0)).toBe(1);

    // One copy goes out.
    expect(
      await waitFor(
        async () =>
          (await prisma.recipient.findUniqueOrThrow({ where: { id: recipient.id } })).deliveryFailedAt === null,
      ),
    ).toBe(true);
    expect(await prisma.documentAuditLog.count({ where: { envelopeId: document.id, type: 'EMAIL_SENT' } })).toBe(1);

    if (MAIL_SINK_URL) {
      const res = await fetch(`${MAIL_SINK_URL}/api/v1/search?query=${encodeURIComponent(`to:"${recipient.email}"`)}`);
      const body = (await res.json()) as { messages?: unknown[] };
      expect(body.messages ?? []).toHaveLength(1);
    }

    // Also right after that job finished: still one.
    const again = await resendSignedCopy(request, team.id, { envelopeId: document.id, recipientId: recipient.id });
    expect(again.status()).toBe(400);
    expect(await completedEmailJobsFor(document.id)).toHaveLength(1);
  });

  test('G1-D1: a double click on the button sends one request', async ({ page }) => {
    const { user, team, document, recipient } = await seedUndeliveredCopy();

    const calls: string[] = [];
    page.on('request', (req) => {
      if (req.url().includes('lifecycle.resendSignedCopy')) {
        calls.push(req.url());
      }
    });

    await apiSignin({ page, email: user.email, redirectPath: `/t/${team.url}/documents/${document.id}` });

    const badge = page.getByTestId(`recipient-copy-not-delivered-${recipient.id}`);
    await expect(badge).toBeVisible({ timeout: 30_000 });
    await badge.hover();

    const button = page.getByTestId(`recipient-resend-signed-copy-${recipient.id}`);
    await button.dblclick();
    await expect(page.getByText('Signed copy on its way').first()).toBeVisible();
    await expect(button).toBeDisabled();

    expect(calls).toHaveLength(1);
    expect(await completedEmailJobsFor(document.id)).toHaveLength(1);
  });

  test('a resend that is given up marks the recipient again and tells the owner again', async () => {
    const { document, recipient } = await seedUndeliveredCopy();

    const givenUpJob = async (payload: Prisma.InputJsonValue, recipientIds: number[]) => {
      const job = await prisma.backgroundJob.create({
        data: {
          jobId: 'send.document.completed.emails',
          name: 'Send Document Completed Emails',
          version: '1.0.0',
          payload,
          status: 'FAILED',
          retried: 5,
          maxRetries: 5,
        },
      });

      await prisma.backgroundJobTask.create({
        data: {
          id: `task-plan-${job.id}`,
          name: 'completed-email-plan',
          jobId: job.id,
          status: 'COMPLETED',
          result: { isOwnerCopyIntended: false, recipientIds },
          completedAt: new Date(),
        },
      });

      await markCompletedEmailsUndelivered({ jobRowId: job.id, payload, attempts: 6 });
    };

    const notices = async () =>
      await prisma.backgroundJob.count({
        where: {
          jobId: 'send.solidten.notice.email',
          AND: [
            { payload: { path: ['kind'], equals: 'COMPLETED_DOCUMENT_NOT_DELIVERED' } },
            { payload: { path: ['envelopeId'], equals: document.id } },
          ],
        },
      });

    // The first send was given up: the owner was told once.
    await givenUpJob({ envelopeId: document.id }, [recipient.id]);
    expect(await notices()).toBe(1);

    // The owner resent, and the resend was given up too (the mark stays until a send is accepted).
    await givenUpJob({ envelopeId: document.id, resend: { recipientId: recipient.id, userId: document.userId } }, [
      recipient.id,
    ]);

    expect((await prisma.recipient.findUniqueOrThrow({ where: { id: recipient.id } })).deliveryFailedAt).not.toBeNull();

    const notDelivered = await prisma.documentAuditLog.findMany({
      where: { envelopeId: document.id, type: 'EMAIL_NOT_DELIVERED' },
    });
    expect(notDelivered).toHaveLength(2);
    expect(notDelivered[1].data).toMatchObject({ recipientId: recipient.id, emailType: 'DOCUMENT_COMPLETED' });

    // Its own notice, not swallowed by the first give-up's (once per envelope).
    expect(await notices()).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/*   G2: a retention purge erases the audit log of the purged document        */
/* -------------------------------------------------------------------------- */

const rule = (overrides: Partial<TRetentionSettings> = {}): TRetentionSettings => ({
  enabled: true,
  action: 'PURGE',
  days: 30,
  includeRejected: false,
  includeCancelled: false,
  ...overrides,
});

/** A team rule saved long enough ago for a purge to run (the 7-day wait counts from the change). */
const setTeamRule = async (teamId: number, settings: TRetentionSettings) => {
  const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId } });

  await prisma.teamGlobalSettings.update({
    where: { id: team.teamGlobalSettingsId },
    data: { retentionSettings: settings },
  });

  await prisma.stSettingsAuditLog.create({
    data: {
      organisationId: team.organisationId,
      teamId,
      setting: 'retentionSettings',
      newValue: settings,
      userEmail: 'seed@test.documenso.com',
      createdAt: new Date(Date.now() - 8 * DAY),
    },
  });
};

/** An old completed document with audit rows that hold what a real one holds. */
const seedOldDocumentWithAuditLog = async (settings: TRetentionSettings) => {
  const { user, team } = await seedUser();
  await setTeamRule(team.id, settings);

  const signerEmails = [uniqueEmail('purge-a'), uniqueEmail('purge-b')];
  const typedValue = `typed-value-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const userAgent = `PurgeAgent-${typedValue}`;
  const completedAt = new Date(Date.now() - 90 * DAY);

  const document = await seedCompletedDocument(user, team.id, signerEmails, {
    internalVersion: 2,
    createDocumentOptions: { status: DocumentStatus.COMPLETED, completedAt },
  });

  const recipients = await prisma.recipient.findMany({ where: { envelopeId: document.id } });

  await prisma.documentAuditLog.createMany({
    data: [
      {
        envelopeId: document.id,
        type: 'DOCUMENT_FIELD_INSERTED',
        data: { recipientEmail: signerEmails[0], recipientName: 'Purge A', field: { type: 'TEXT', data: typedValue } },
        email: signerEmails[0],
        name: 'Purge A',
        ipAddress: '203.0.113.77',
        userAgent,
      },
      {
        envelopeId: document.id,
        type: 'EMAIL_SENT',
        data: { recipientEmail: signerEmails[1], recipientName: 'Purge B', emailType: 'SIGNING_REQUEST' },
        email: user.email,
        name: user.name,
        userId: user.id,
        ipAddress: '203.0.113.78',
        userAgent,
      },
      { envelopeId: document.id, type: 'DOCUMENT_COMPLETED', data: { transactionId: 'seed' } },
    ],
  });

  return { user, team, document, recipients, signerEmails, typedValue, userAgent, completedAt };
};

const rowsHolding = async (envelopeId: string, needles: string[]) => {
  // A purged document's rows are either gone or unlinked (envelopeId NULL).
  const rows = await prisma.documentAuditLog.findMany({ where: { OR: [{ envelopeId }, { envelopeId: null }] } });

  return rows.filter((row) => needles.some((needle) => JSON.stringify(row).includes(needle)));
};

test.describe('G2: retention purge and the audit log', () => {
  test('the purge erases every audit row of the document and keeps one record without personal data', async () => {
    const { document, signerEmails, typedValue, userAgent, completedAt, user } = await seedOldDocumentWithAuditLog(
      rule(),
    );

    const before = await prisma.documentAuditLog.count({ where: { envelopeId: document.id } });
    expect(before).toBe(3);

    const outcome = await applyRetentionToEnvelope({ envelopeId: document.id, dryRun: false });
    expect(outcome.result).toBe('PURGED');

    // Nothing of the document's audit log is left with a name, address, IP, user agent or value.
    expect(await rowsHolding(document.id, [...signerEmails, typedValue, user.email, userAgent])).toEqual([]);

    const left = await prisma.documentAuditLog.findMany({
      where: { data: { path: ['envelopeId'], equals: document.id } },
    });
    expect(left).toHaveLength(1);

    const [record] = left;
    expect(record.type).toBe('DOCUMENT_RETENTION_APPLIED');
    expect(record.envelopeId).toBeNull();
    expect(record).toMatchObject({ userId: null, email: null, name: null, ipAddress: null });
    expect(record.userAgent).toBe('Solid Ten Sign retention');
    expect(record.data).toMatchObject({
      action: 'PURGE',
      envelopeId: document.id,
      completedAt: completedAt.toISOString(),
      recipientCount: 2,
      erasedAuditLogCount: before,
      auditLogIds: [],
    });
    expect(JSON.stringify(record.data)).not.toContain(document.title);
    expect(Date.now() - record.createdAt.getTime()).toBeLessThan(5 * 60 * 1000);
  });

  test('a purge that fails leaves the audit log as it was (same transaction)', async () => {
    const { document } = await seedOldDocumentWithAuditLog(rule());

    const item = await prisma.envelopeItem.findFirstOrThrow({ where: { envelopeId: document.id } });
    const suffix = item.documentDataId.replace(/[^a-z0-9]/gi, '');

    // Make this one purge fail late in its transaction (after the audit rows were erased).
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION audit_g_fail_${suffix}() RETURNS trigger AS $$
      BEGIN
        IF OLD.id = '${item.documentDataId}' THEN RAISE EXCEPTION 'audit-g forced failure'; END IF;
        RETURN OLD;
      END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER audit_g_fail_${suffix} BEFORE DELETE ON "DocumentData" FOR EACH ROW EXECUTE FUNCTION audit_g_fail_${suffix}()`,
    );

    try {
      await expect(applyRetentionToEnvelope({ envelopeId: document.id, dryRun: false })).rejects.toThrow();
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS audit_g_fail_${suffix} ON "DocumentData"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS audit_g_fail_${suffix}()`);
    }

    expect(await prisma.envelope.findUnique({ where: { id: document.id } })).not.toBeNull();
    expect(await prisma.documentAuditLog.count({ where: { envelopeId: document.id } })).toBe(3);
    expect(
      await prisma.documentAuditLog.count({ where: { data: { path: ['envelopeId'], equals: document.id } } }),
    ).toBe(0);

    // The next run purges it.
    expect((await applyRetentionToEnvelope({ envelopeId: document.id, dryRun: false })).result).toBe('PURGED');
    expect(
      await prisma.documentAuditLog.count({ where: { data: { path: ['envelopeId'], equals: document.id } } }),
    ).toBe(1);
  });

  test('a retention soft delete keeps the audit log (unchanged)', async () => {
    const { document } = await seedOldDocumentWithAuditLog(rule({ action: 'SOFT_DELETE' }));

    expect((await applyRetentionToEnvelope({ envelopeId: document.id, dryRun: false })).result).toBe('SOFT_DELETED');
    expect(await prisma.documentAuditLog.count({ where: { envelopeId: document.id } })).toBe(4);
  });
});
