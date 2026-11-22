import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { completeDocumentWithToken } from '@documenso/lib/server-only/document/complete-document-with-token';
import { applyRetentionToEnvelope } from '@documenso/lib/server-only/retention/apply-retention';
import { DOCUMENT_AUDIT_LOG_TYPE } from '@documenso/lib/types/document-audit-logs';
import { prisma } from '@documenso/prisma';
import { seedCompletedDocument } from '@documenso/prisma/seed/documents';
import { seedUser } from '@documenso/prisma/seed/users';
import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { DocumentStatus, WebhookTriggerEvents } from '@prisma/client';

import { apiSeedPendingDocument } from '../fixtures/api-seeds';
import { apiSignin, WEBAPP_ORIGIN_HEADERS } from '../fixtures/authentication';
import { waitForHydration } from '../fixtures/hydration';

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();

test.describe.configure({ mode: 'parallel' });

const uniqueEmail = (label: string) =>
  `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.documenso.com`;

const seedWithComments = async (request: APIRequestContext, options: { enableComments?: boolean } = {}) => {
  const { enableComments = true } = options;

  const seeded = await apiSeedPendingDocument(request, {
    title: '[TEST] Comments',
    recipients: [
      { email: uniqueEmail('asker'), name: 'Asking Signer' },
      { email: uniqueEmail('other'), name: 'Other Signer' },
    ],
  });

  if (enableComments) {
    await prisma.teamGlobalSettings.update({
      where: { id: seeded.team.teamGlobalSettingsId },
      data: { commentsEnabled: true },
    });
  }

  const recipients = await prisma.recipient.findMany({
    where: { envelopeId: seeded.envelope.id },
    orderBy: { id: 'asc' },
  });

  return { ...seeded, recipients };
};

/** Call the public signer routes the way the signing page does. */
const recipientPost = async (request: APIRequestContext, token: string, body: string) =>
  await request.post(`${WEBAPP_BASE_URL}/api/trpc/comment.postAsRecipient`, {
    headers: { ...WEBAPP_ORIGIN_HEADERS, 'content-type': 'application/json' },
    data: JSON.stringify({ json: { token, body } }),
  });

const recipientRead = async (request: APIRequestContext, token: string) => {
  const response = await request.get(
    `${WEBAPP_BASE_URL}/api/trpc/comment.getForRecipient?input=${encodeURIComponent(JSON.stringify({ json: { token } }))}`,
    { headers: WEBAPP_ORIGIN_HEADERS },
  );

  expect(response.ok(), await response.text()).toBe(true);

  return (await response.json()).result.data.json as {
    enabled: boolean;
    isClosed?: boolean;
    comments?: { body: string; authorType: string }[];
  };
};

const teamReply = async (page: Page, teamId: number, input: { envelopeId: string; threadId: string; body: string }) =>
  await page.context().request.post(`${WEBAPP_BASE_URL}/api/trpc/comment.reply`, {
    headers: { ...WEBAPP_ORIGIN_HEADERS, 'content-type': 'application/json', 'x-team-id': String(teamId) },
    data: JSON.stringify({ json: input }),
  });

const openComments = async (page: Page, token: string) => {
  await page.goto(`/sign/${token}`);

  const button = page.getByRole('button', { name: 'Questions and comments' });

  await expect(async () => {
    await button.click({ timeout: 2_000 });
    await expect(page.getByTestId('signer-comments-dialog')).toBeVisible({ timeout: 2_000 });
  }).toPass();

  return page.getByTestId('signer-comments-dialog');
};

test('[COMMENTS]: off by default, so the signing page offers nothing', async ({ page, request }) => {
  const { recipients } = await seedWithComments(request, { enableComments: false });

  await page.goto(`/sign/${recipients[0].token}`);
  await expect(page.getByRole('button', { name: 'Reject Document' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Questions and comments' })).toHaveCount(0);

  const posted = await recipientPost(request, recipients[0].token, 'Hello?');
  expect(posted.ok()).toBe(false);
  expect(await posted.text()).toContain('Comments are turned off for this document.');
});

test('[COMMENTS]: a signer asks, the team replies, the other recipient cannot read it', async ({ page, request }) => {
  const { envelope, user, team, recipients, token } = await seedWithComments(request);
  const [asker, other] = recipients;

  await prisma.webhook.create({
    data: {
      webhookUrl: 'https://example.com/solidten-comment-hook',
      eventTriggers: [WebhookTriggerEvents.DOCUMENT_COMMENT_CREATED],
      secret: null,
      enabled: true,
      userId: user.id,
      teamId: team.id,
    },
  });

  const question = '<img src=x onerror="window.__xss=1"><b>Bold?</b> Can the start date move to the 1st?';

  const dialog = await openComments(page, asker.token);
  await expect(dialog.getByText('No comments yet. Ask a question before you sign.')).toBeVisible();

  await dialog.getByLabel('Your comment').fill(question);
  await dialog.getByRole('button', { name: 'Send' }).click();

  // HTML is shown as text, never rendered.
  const body = dialog.getByTestId('comment-body').first();
  await expect(body).toHaveText(question);
  await expect(body.locator('img, b')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();

  // Evidence: the audit entry references the comment; the text lives in the comment row.
  const comment = await prisma.envelopeComment.findFirstOrThrow({ where: { envelopeId: envelope.id } });
  expect(comment.body).toBe(question);

  const auditLog = await prisma.documentAuditLog.findFirstOrThrow({
    where: { envelopeId: envelope.id, type: DOCUMENT_AUDIT_LOG_TYPE.COMMENT_CREATED },
  });
  expect(auditLog.email).toBe(asker.email);
  expect(auditLog.data).toEqual(expect.objectContaining({ commentId: comment.id, authorType: 'RECIPIENT' }));
  expect(auditLog.data).not.toHaveProperty('body');

  // The owner is told by email, and the webhook fires.
  await expect
    .poll(async () =>
      (await prisma.backgroundJob.findMany({ where: { jobId: 'send.solidten.notice.email' }, take: 500 })).some((job) =>
        JSON.stringify(job.payload).includes(comment.id),
      ),
    )
    .toBe(true);

  await expect
    .poll(async () =>
      (await prisma.backgroundJob.findMany({ where: { jobId: 'internal.execute-webhook' }, take: 500 })).some(
        (job) =>
          JSON.stringify(job.payload).includes('DOCUMENT_COMMENT_CREATED') &&
          JSON.stringify(job.payload).includes(comment.id),
      ),
    )
    .toBe(true);

  // The webhook payload carries no signing link token.
  const webhookJobs = (
    await prisma.backgroundJob.findMany({ where: { jobId: 'internal.execute-webhook' }, take: 500 })
  ).filter((job) => JSON.stringify(job.payload).includes(comment.id));

  for (const job of webhookJobs) {
    expect(JSON.stringify(job.payload)).not.toContain(asker.token);
    expect(JSON.stringify(job.payload)).not.toContain(other.token);
  }

  // The other recipient sees nothing of it.
  const otherView = await recipientRead(request, other.token);
  expect(otherView.enabled).toBe(true);
  expect(otherView.comments).toEqual([]);

  // The team sees an unread marker, reads and replies.
  await apiSignin({ page, email: user.email, redirectPath: `/t/${team.url}/documents/${envelope.id}` });

  const panel = page.getByTestId('document-comments');
  await expect(panel.getByTestId('comments-unread')).toHaveText('1 new');

  await waitForHydration(page, '[data-testid="document-comments"] button');
  await panel.getByRole('button', { name: 'Show' }).click();
  await expect(panel.getByTestId('comment-body').first()).toHaveText(question);
  await expect(panel.getByTestId('comments-unread')).toHaveCount(0);

  await panel.getByLabel('Your reply').fill('Yes, the 1st works for us.');
  await panel.getByRole('button', { name: 'Reply' }).click();
  await expect(panel.getByText('Yes, the 1st works for us.')).toBeVisible();

  await panel.getByRole('button', { name: 'Resolve' }).click();
  await expect(panel.getByText('Resolved', { exact: true })).toBeVisible();

  const resolvedLog = await prisma.documentAuditLog.findFirst({
    where: { envelopeId: envelope.id, type: DOCUMENT_AUDIT_LOG_TYPE.COMMENT_THREAD_RESOLVED },
  });
  expect(resolvedLog?.data).toEqual(expect.objectContaining({ resolved: true }));

  // The signer reads the reply; the other recipient still sees nothing.
  const askerView = await recipientRead(request, asker.token);
  expect(askerView.comments?.map((c) => c.body)).toEqual([question, 'Yes, the 1st works for us.']);
  expect((await recipientRead(request, other.token)).comments).toEqual([]);

  // A team member cannot reply into a thread on another document.
  const thread = await prisma.envelopeCommentThread.findFirstOrThrow({ where: { envelopeId: envelope.id } });
  const elsewhere = await apiSeedPendingDocument(request, { context: { user, team, token } });

  const crossed = await teamReply(page, team.id, { envelopeId: elsewhere.envelope.id, threadId: thread.id, body: 'x' });
  expect(crossed.ok()).toBe(false);
});

test('[COMMENTS]: with one shared thread every recipient reads it', async ({ request }) => {
  const { envelope, recipients } = await seedWithComments(request);
  const [asker, other] = recipients;

  await prisma.envelopeCommentSettings.create({ data: { envelopeId: envelope.id, enabled: true, sharedThread: true } });

  expect((await recipientPost(request, asker.token, 'Is page 2 final?')).ok()).toBe(true);

  const otherView = await recipientRead(request, other.token);
  expect(otherView.comments?.map((c) => c.body)).toEqual(['Is page 2 final?']);
});

test('[COMMENTS]: posts are rate limited per link', async ({ request }) => {
  test.skip(
    process.env.DANGEROUS_BYPASS_RATE_LIMITS === 'true',
    'Rate limits are bypassed in this run (DANGEROUS_BYPASS_RATE_LIMITS=true).',
  );

  const { recipients } = await seedWithComments(request);

  for (let index = 1; index <= 5; index++) {
    const response = await recipientPost(request, recipients[0].token, `Question ${index}`);
    expect(response.ok(), await response.text()).toBe(true);
  }

  const limited = await recipientPost(request, recipients[0].token, 'One too many');
  expect(limited.status()).toBe(429);

  // Solid Ten (LD3-L1): the same 429 as the limiter in front of tRPC.
  const { error } = await limited.json();
  expect(error.json.code).toBe(-32029);
  expect(error.json.data.code).toBe('TOO_MANY_REQUESTS');
  expect(error.json.message).toBe('Too many requests. Wait a moment, then try again.');
  expect(Number(limited.headers()['retry-after'])).toBeGreaterThan(0);
});

test('[COMMENTS]: comments close when the document completes', async ({ page, request }) => {
  const { envelope, user, team, recipients } = await seedWithComments(request);

  // The sealed file then carries the audit log, which lists the comments.
  await prisma.teamGlobalSettings.update({
    where: { id: team.teamGlobalSettingsId },
    data: { includeAuditLog: true },
  });

  expect((await recipientPost(request, recipients[0].token, 'Before signing')).ok()).toBe(true);

  for (const recipient of recipients) {
    const fields = await prisma.field.findMany({ where: { recipientId: recipient.id } });

    for (const field of fields) {
      await prisma.field.update({ where: { id: field.id }, data: { inserted: true, customText: 'Signed' } });
      await prisma.signature.create({
        data: { fieldId: field.id, recipientId: recipient.id, typedSignature: recipient.name },
      });
    }

    await completeDocumentWithToken({ token: recipient.token, id: { type: 'envelopeId', id: envelope.id } });
  }

  await expect
    .poll(async () => (await prisma.envelope.findUniqueOrThrow({ where: { id: envelope.id } })).status, {
      timeout: 30_000,
    })
    .toBe(DocumentStatus.COMPLETED);

  const posted = await recipientPost(request, recipients[1].token, 'After signing');
  expect(posted.ok()).toBe(false);

  const view = await recipientRead(request, recipients[0].token);
  expect(view.isClosed).toBe(true);

  const thread = await prisma.envelopeCommentThread.findFirstOrThrow({ where: { envelopeId: envelope.id } });

  await apiSignin({ page, email: user.email, redirectPath: `/t/${team.url}/documents/${envelope.id}` });

  const panel = page.getByTestId('document-comments');
  await waitForHydration(page, '[data-testid="document-comments"] button');
  await panel.getByRole('button', { name: 'Show' }).click();
  await expect(panel.getByText('Comments are closed because the document is complete.')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Reply' })).toHaveCount(0);

  const reply = await teamReply(page, team.id, { envelopeId: envelope.id, threadId: thread.id, body: 'Too late' });
  expect(reply.ok()).toBe(false);
  expect(await reply.text()).toContain('Comments are closed because the document is complete.');
});

test('[COMMENTS]: a reassigned recipient starts a fresh thread', async ({ request }) => {
  const { envelope, recipients, token } = await seedWithComments(request);
  const [asker] = recipients;

  expect((await recipientPost(request, asker.token, 'My private question')).ok()).toBe(true);

  const reassigned = await request.post(`${WEBAPP_BASE_URL}/api/v2-beta/envelope/recipient/reassign`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { envelopeId: envelope.id, recipientId: asker.id, name: 'New Person', email: uniqueEmail('new') },
  });
  expect(reassigned.ok(), await reassigned.text()).toBe(true);

  const updated = await prisma.recipient.findUniqueOrThrow({ where: { id: asker.id } });

  // The old link is dead and the new person does not see the old conversation.
  expect((await recipientPost(request, asker.token, 'Old link')).ok()).toBe(false);
  expect((await recipientRead(request, updated.token)).comments).toEqual([]);

  expect((await recipientPost(request, updated.token, 'New question')).ok()).toBe(true);

  const threads = await prisma.envelopeCommentThread.findMany({ where: { envelopeId: envelope.id } });
  expect(threads).toHaveLength(2);
});

test('[COMMENTS]: the retention purge deletes comments and in-person sessions, and keeps the audit rows', async () => {
  const { user, team } = await seedUser();

  await prisma.teamGlobalSettings.update({
    where: { id: team.teamGlobalSettingsId },
    data: {
      retentionSettings: { enabled: true, action: 'PURGE', days: 30, includeRejected: false, includeCancelled: false },
    },
  });

  // A purge runs only 7 days after the last recorded rule change (S-M3).
  await prisma.stSettingsAuditLog.create({
    data: {
      organisationId: team.organisationId,
      teamId: team.id,
      setting: 'retentionSettings',
      userEmail: 'seed@test.documenso.com',
      createdAt: new Date(Date.now() - 8 * 86_400_000),
    },
  });

  const now = new Date();

  const document = await seedCompletedDocument(user, team.id, [uniqueEmail('purge')], {
    internalVersion: 2,
    createDocumentOptions: { status: DocumentStatus.COMPLETED, completedAt: new Date(now.getTime() - 40 * 86_400_000) },
  });

  const thread = await prisma.envelopeCommentThread.create({
    data: { envelopeId: document.id, key: 'shared' },
  });

  const comment = await prisma.envelopeComment.create({
    data: {
      threadId: thread.id,
      envelopeId: document.id,
      authorType: 'RECIPIENT',
      authorName: 'Someone',
      authorEmail: 'someone@test.documenso.com',
      body: 'Kept only until the purge',
    },
  });

  await prisma.envelopeCommentSettings.create({ data: { envelopeId: document.id, enabled: true, sharedThread: true } });

  const commentLog = await prisma.documentAuditLog.create({
    data: {
      envelopeId: document.id,
      type: 'COMMENT_CREATED',
      data: {
        commentId: comment.id,
        threadId: thread.id,
        isSharedThread: true,
        threadRecipientId: null,
        authorType: 'RECIPIENT',
        authorRecipientId: null,
        length: comment.body.length,
      },
    },
  });

  const inPersonSession = await prisma.inPersonSigningSession.create({
    data: {
      envelopeId: document.id,
      hostUserId: user.id,
      authSessionId: 'not-a-session',
      exitPinHash: 'x',
      expiresAt: new Date(now.getTime() - 1000),
      endedAt: new Date(now.getTime() - 1000),
    },
  });

  const outcome = await applyRetentionToEnvelope({ envelopeId: document.id, now, dryRun: false });
  expect(outcome.result).toBe('PURGED');

  expect(await prisma.envelopeCommentThread.count({ where: { id: thread.id } })).toBe(0);
  expect(await prisma.envelopeComment.count({ where: { id: comment.id } })).toBe(0);
  expect(await prisma.envelopeCommentSettings.count({ where: { envelopeId: document.id } })).toBe(0);
  expect(await prisma.inPersonSigningSession.count({ where: { id: inPersonSession.id } })).toBe(0);

  // Solid Ten Sign (G2): the audit entry goes with the purged document.
  expect(await prisma.documentAuditLog.count({ where: { id: commentLog.id } })).toBe(0);
});
