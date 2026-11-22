/**
 * Regression tests for the security review of the final build (FINDINGS.md,
 * "Security review of the final build", S-H1 to S-L6). Each test reproduces the
 * reviewer's steps and fails on the build the review was run against.
 */
import { createHash, randomBytes } from 'node:crypto';
import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { DOCUMENSO_ENCRYPTION_KEY } from '@documenso/lib/constants/crypto';
import { enableTwoFactorAuthentication } from '@documenso/lib/server-only/2fa/enable-2fa';
import { getBackupCodes } from '@documenso/lib/server-only/2fa/get-backup-code';
import { setupTwoFactorAuthentication } from '@documenso/lib/server-only/2fa/setup-2fa';
import { completeDocumentWithToken } from '@documenso/lib/server-only/document/complete-document-with-token';
import { getServerOperatorRecipients } from '@documenso/lib/server-only/email/server-operators';
import { getDailyQuotaBucket } from '@documenso/lib/server-only/rate-limit/daily-quota';
import { recordServerCapReached } from '@documenso/lib/server-only/rate-limit/server-cap-alerts';
import { disableUser } from '@documenso/lib/server-only/user/disable-user';
import { symmetricDecrypt } from '@documenso/lib/universal/crypto';
import { prisma } from '@documenso/prisma';
import { seedTeamMember } from '@documenso/prisma/seed/teams';
import { seedUser } from '@documenso/prisma/seed/users';
import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { base32 } from '@scure/base';
import { generateHOTP } from 'oslo/otp';

import { apiSeedPendingDocument } from '../fixtures/api-seeds';
import { apiSignin, WEBAPP_ORIGIN_HEADERS } from '../fixtures/authentication';
import { getCanvasBox, getPageCanvas } from '../fixtures/contents';
import { waitForHydration } from '../fixtures/hydration';

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();

test.describe.configure({ mode: 'parallel' });

const PIN = '4826';

const uniqueEmail = (label: string) =>
  `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.documenso.com`;

const trpcPost = async (requestContext: APIRequestContext, path: string, input: unknown, teamId?: number) =>
  await requestContext.post(`${WEBAPP_BASE_URL}/api/trpc/${path}`, {
    headers: {
      ...WEBAPP_ORIGIN_HEADERS,
      'content-type': 'application/json',
      ...(teamId ? { 'x-team-id': String(teamId) } : {}),
    },
    data: JSON.stringify({ json: input }),
  });

const trpcGet = async (requestContext: APIRequestContext, path: string, input: unknown, teamId?: number) =>
  await requestContext.get(
    `${WEBAPP_BASE_URL}/api/trpc/${path}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`,
    { headers: { ...WEBAPP_ORIGIN_HEADERS, ...(teamId ? { 'x-team-id': String(teamId) } : {}) } },
  );

const getCurrentTotpCode = async (userId: number) => {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

  if (!DOCUMENSO_ENCRYPTION_KEY || !user.twoFactorSecret) {
    throw new Error('Expected encryption key and 2FA secret');
  }

  const secret = Buffer.from(symmetricDecrypt({ key: DOCUMENSO_ENCRYPTION_KEY, data: user.twoFactorSecret })).toString(
    'utf-8',
  );

  return await generateHOTP(base32.decode(secret), Math.floor(Date.now() / 30_000));
};

const seedSigners = async (request: APIRequestContext, count = 2) => {
  const signers = Array.from({ length: count }, (_, index) => ({
    email: uniqueEmail(`signer${index + 1}`),
    name: `Signer ${index + 1}`,
    signingOrder: index + 1,
  }));

  const seeded = await apiSeedPendingDocument(request, { title: '[TEST] Security', recipients: signers });

  const recipients = await prisma.recipient.findMany({
    where: { envelopeId: seeded.envelope.id },
    orderBy: { id: 'asc' },
  });

  return { ...seeded, recipients };
};

/* -------------------------------------------------------------------------- */
/*                             In-person helpers                              */
/* -------------------------------------------------------------------------- */

const startInPersonSession = async (page: Page, input: { envelopeId: string; teamId: number }) => {
  const response = await trpcPost(
    page.context().request,
    'inPerson.start',
    { envelopeId: input.envelopeId, pin: PIN, emailCodeRecipientIds: [] },
    input.teamId,
  );

  expect(response.ok(), await response.text()).toBe(true);

  return (await response.json()).result.data.json.sessionId as string;
};

const handOverAndConfirm = async (page: Page, sessionId: string, recipientId: number, name: string) => {
  await page.goto(`/in-person/${sessionId}`);
  await waitForHydration(page, `[data-testid="in-person-signer-${recipientId}"] button`);

  await expect(async () => {
    if (await page.getByTestId('in-person-handover').isVisible()) {
      return;
    }

    await page
      .getByTestId(`in-person-signer-${recipientId}`)
      .getByRole('button', { name: 'Hand over to sign' })
      .click({ timeout: 2_000 });

    await expect(page.getByTestId('in-person-handover')).toBeVisible({ timeout: 3_000 });
  }).toPass();

  await waitForHydration(page, '#in-person-name');

  await expect(async () => {
    await page.getByLabel('Your full name').fill(name);
    await expect(page.getByRole('button', { name: 'Confirm and continue' })).toBeEnabled({ timeout: 500 });
  }).toPass();

  await page.getByRole('button', { name: 'Confirm and continue' }).click();
  await page.waitForURL(`/in-person/${sessionId}/sign`);
};

/* -------------------------------------------------------------------------- */
/*                                    S-H1                                    */
/* -------------------------------------------------------------------------- */

test('[S-H1]: the in-person device never sees the signer link token, and its turn credential dies with the turn', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);

  const { envelope, user, team, recipients } = await seedSigners(request);
  const [first] = recipients;

  await apiSignin({ page, email: user.email, redirectPath: `/t/${team.url}/documents/${envelope.id}` });

  const sessionId = await startInPersonSession(page, { envelopeId: envelope.id, teamId: team.id });

  // Everything the device receives once it is handed over.
  const bodies: string[] = [];

  page.on('response', async (response) => {
    const type = response.headers()['content-type'] ?? '';

    if (type.includes('json') || type.includes('html') || type.includes('text')) {
      bodies.push(await response.text().catch(() => ''));
    }
  });

  await handOverAndConfirm(page, sessionId, first.id, 'Signer 1');
  await expect(getPageCanvas(page)).toBeVisible({ timeout: 30_000 });

  const html = await page.content();

  expect(html).not.toContain(first.token);
  expect(bodies.some((body) => body.includes(first.token))).toBe(false);

  const session = await prisma.inPersonSigningSession.findUniqueOrThrow({ where: { id: sessionId } });
  const credential = session.turnToken ?? '';

  expect(credential).toMatch(/^ipt_/);
  expect(html).toContain(credential);

  const envelopeItem = await prisma.envelopeItem.findFirstOrThrow({ where: { envelopeId: envelope.id } });
  const fileUrl = (token: string) => `${WEBAPP_BASE_URL}/api/files/token/${token}/envelopeItem/${envelopeItem.id}`;

  // The credential works only from the device that runs the turn.
  expect((await page.context().request.get(fileUrl(credential))).status()).toBe(200);
  expect((await request.get(fileUrl(credential))).status()).toBe(404);

  const signFromElsewhere = await trpcPost(request, 'envelope.field.sign', {
    token: credential,
    fieldId: (await prisma.field.findFirstOrThrow({ where: { recipientId: first.id } })).id,
    fieldValue: { type: 'SIGNATURE', value: 'Not the signer' },
  });
  expect(signFromElsewhere.ok()).toBe(false);

  // The signer signs with the credential: the normal page works without the link token.
  await page.getByTestId('signature-pad-dialog-button').click();
  await page.getByRole('tab', { name: 'Type' }).click();
  await page.getByTestId('signature-pad-type-input').fill('Signature');
  await page.getByRole('button', { name: 'Next' }).click();

  const canvasBox = await getCanvasBox(page);
  await getPageCanvas(page).click({
    position: { x: (17.5 / 100) * canvasBox.width, y: (12.5 / 100) * canvasBox.height },
  });
  await expect(page.getByText('0 Fields Remaining').first()).toBeVisible({ timeout: 10_000 });

  // The turn ends without completing: the credential is cleared and dead, even on the device.
  const stop = await trpcPost(page.context().request, 'inPerson.stopTurn', { sessionId });
  expect(stop.ok(), await stop.text()).toBe(true);

  const after = await prisma.inPersonSigningSession.findUniqueOrThrow({ where: { id: sessionId } });
  expect(after.turnToken).toBeNull();
  expect((await page.context().request.get(fileUrl(credential))).status()).toBe(404);

  const completeAfterTurn = await trpcPost(page.context().request, 'recipient.completeDocumentWithToken', {
    token: credential,
    documentId: Number(envelope.secondaryId.replace(/\D/g, '')),
  });
  expect(completeAfterTurn.ok()).toBe(false);

  const firstAfter = await prisma.recipient.findUniqueOrThrow({ where: { id: first.id } });
  expect(firstAfter.signingStatus).toBe('NOT_SIGNED');

  // The signer's own emailed link still works.
  expect((await request.get(fileUrl(first.token))).status()).toBe(200);

  expect(bodies.some((body) => body.includes(first.token))).toBe(false);
});

/* -------------------------------------------------------------------------- */
/*                         SEC2-M1 (security retest)                          */
/* -------------------------------------------------------------------------- */

test('[SEC2-M1]: a turn credential typed into a comment, a text field or a name is never swapped for the link token', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);

  const { envelope, user, team, recipients } = await seedSigners(request);
  const [first, second] = recipients;

  await prisma.envelopeCommentSettings.create({
    data: { envelopeId: envelope.id, enabled: true, sharedThread: true },
  });

  const signatureField = await prisma.field.findFirstOrThrow({ where: { recipientId: first.id } });
  const { id: _id, secondaryId: _secondaryId, ...fieldCopy } = signatureField;
  const textField = await prisma.field.create({
    data: {
      ...fieldCopy,
      fieldMeta: { type: 'text' },
      type: 'TEXT',
      positionY: Number(signatureField.positionY) + 20,
      customText: '',
      inserted: false,
    },
  });

  await apiSignin({ page, email: user.email, redirectPath: `/t/${team.url}/documents/${envelope.id}` });

  const sessionId = await startInPersonSession(page, { envelopeId: envelope.id, teamId: team.id });
  await handOverAndConfirm(page, sessionId, first.id, 'Signer 1');

  const { turnToken } = await prisma.inPersonSigningSession.findUniqueOrThrow({ where: { id: sessionId } });
  const credential = turnToken ?? '';
  expect(credential).toMatch(/^ipt_/);

  const device = page.context().request;

  // 1. A comment on the shared thread.
  const comment = await trpcPost(device, 'comment.postAsRecipient', {
    token: credential,
    body: `my code is ${credential}`,
  });
  expect(comment.ok(), await comment.text()).toBe(true);

  const stored = await prisma.envelopeComment.findFirstOrThrow({ where: { envelopeId: envelope.id } });
  expect(stored.body).not.toContain(first.token);
  expect(stored.body).toBe(`my code is ${credential}`);

  // The other signer reads the shared thread: no reusable link token in it.
  const secondReads = await trpcGet(request, 'comment.getForRecipient', { token: second.token });
  expect(secondReads.ok(), await secondReads.text()).toBe(true);
  expect(await secondReads.text()).not.toContain(first.token);

  // 2. A text field value.
  const sign = await trpcPost(device, 'envelope.field.sign', {
    token: credential,
    fieldId: textField.id,
    fieldValue: { type: 'TEXT', value: `ref ${credential}` },
  });
  expect(sign.ok(), await sign.text()).toBe(true);

  const signedText = await prisma.field.findUniqueOrThrow({ where: { id: textField.id } });
  expect(signedText.customText).not.toContain(first.token);
  expect(signedText.customText).toBe(`ref ${credential}`);

  // 3. A name in a hand-on (whether or not the in-person turn allows it, the link token is never stored).
  const reassign = await trpcPost(device, 'lifecycle.reassignRecipientWithToken', {
    token: credential,
    name: `Pat ${credential}`,
    email: uniqueEmail('pat'),
    reason: credential,
  });
  await reassign.text();

  const names = await prisma.recipient.findMany({ where: { envelopeId: envelope.id }, select: { name: true } });
  for (const { name } of names) {
    expect(name).not.toContain(first.token);
  }

  const auditText = JSON.stringify(await prisma.documentAuditLog.findMany({ where: { envelopeId: envelope.id } }));
  expect(auditText).not.toContain(first.token);
});

/* -------------------------------------------------------------------------- */
/*                          Email-link sign-in helpers                        */
/* -------------------------------------------------------------------------- */

const createEmailLinkToken = async (userId: number) => {
  const token = randomBytes(32).toString('hex');

  await prisma.verificationToken.create({
    data: {
      identifier: 'email-link-signin',
      token: createHash('sha256').update(token).digest('hex'),
      expires: new Date(Date.now() + 15 * 60 * 1000),
      userId,
    },
  });

  return token;
};

const requestEmailLink = async (request: APIRequestContext, email: string, ip: string) =>
  await request.post(`${WEBAPP_BASE_URL}/api/auth/email-link/request`, {
    headers: { ...WEBAPP_ORIGIN_HEADERS, 'content-type': 'application/json', 'x-forwarded-for': ip },
    data: JSON.stringify({ email }),
  });

const authorizeEmailLink = async (
  request: APIRequestContext,
  body: { token: string; totpCode?: string },
  ip = '203.0.113.90',
) =>
  await request.post(`${WEBAPP_BASE_URL}/api/auth/email-link/authorize`, {
    headers: { ...WEBAPP_ORIGIN_HEADERS, 'content-type': 'application/json', 'x-forwarded-for': ip },
    data: JSON.stringify(body),
  });

const liveEmailLinks = async (userId: number) =>
  await prisma.verificationToken.count({
    where: { userId, identifier: 'email-link-signin', completed: false, expires: { gt: new Date() } },
  });

/* -------------------------------------------------------------------------- */
/*                                    S-M1                                    */
/* -------------------------------------------------------------------------- */

test('[S-M1]: requests by a stranger never cancel the owner link or lock the owner out', async ({ browser }) => {
  const { user } = await seedUser();

  const ownerLink = await createEmailLinkToken(user.id);

  // A stranger asks for a link for the owner's address again and again, from many addresses.
  const stranger = await browser.newContext();

  for (let attempt = 1; attempt <= 12; attempt++) {
    const response = await requestEmailLink(stranger.request, user.email, `198.51.100.${attempt}`);
    expect(response.status()).toBe(201);
  }

  // At most 10 live links; none of the owner's are removed.
  await expect.poll(async () => await liveEmailLinks(user.id), { timeout: 20_000 }).toBe(10);

  // The owner can still ask from their own address.
  const owner = await browser.newContext();
  expect((await requestEmailLink(owner.request, user.email, '203.0.113.50')).status()).toBe(201);

  // And the link they already had still signs them in.
  const signedIn = await authorizeEmailLink(owner.request, { token: ownerLink });
  expect(signedIn.status(), await signedIn.text()).toBe(201);

  await stranger.close();
  await owner.close();
});

/* -------------------------------------------------------------------------- */
/*                                    S-M2                                    */
/* -------------------------------------------------------------------------- */

test('[S-M2]: parallel wrong two-factor codes cannot beat the five-attempt limit', async ({ browser }) => {
  const { user } = await seedUser();

  await setupTwoFactorAuthentication({ user });
  const withSecret = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  await enableTwoFactorAuthentication({ user: withSecret, code: await getCurrentTotpCode(user.id) });

  const link = await createEmailLinkToken(user.id);
  const attacker = await browser.newContext();

  // Eight guesses at once, each from its own address.
  const guesses = await Promise.all(
    Array.from({ length: 8 }, async (_, index) =>
      authorizeEmailLink(attacker.request, { token: link, totpCode: `00000${index}` }, `198.51.101.${index + 1}`),
    ),
  );

  expect(guesses.every((response) => response.status() !== 201)).toBe(true);

  // The right code no longer works: the link is used up.
  const right = await authorizeEmailLink(attacker.request, {
    token: link,
    totpCode: await getCurrentTotpCode(user.id),
  });
  expect(right.status()).not.toBe(201);

  const record = await prisma.verificationToken.findFirstOrThrow({
    where: { userId: user.id, identifier: 'email-link-signin' },
  });
  expect(record.completed).toBe(true);

  await attacker.close();
});

/* -------------------------------------------------------------------------- */
/*                                    S-L1                                    */
/* -------------------------------------------------------------------------- */

test('[S-L1]: only the owner or a team admin or manager hosts; a locked device is anonymous everywhere', async ({
  page,
  browser,
  request,
}) => {
  const { envelope, user, team } = await seedSigners(request);

  // A plain member who can see the document cannot host it.
  const member = await seedTeamMember({ teamId: team.id, role: 'MEMBER' });
  const memberContext = await browser.newContext();
  const memberPage = await memberContext.newPage();
  await apiSignin({ page: memberPage, email: member.email });

  const byMember = await trpcPost(
    memberPage.context().request,
    'inPerson.start',
    { envelopeId: envelope.id, pin: PIN, emailCodeRecipientIds: [] },
    team.id,
  );
  expect(byMember.ok()).toBe(false);
  expect(await byMember.text()).toContain('Only the document owner or a team admin or manager');
  await memberContext.close();

  // The owner starts a session: this browser's sign-in is now locked.
  await apiSignin({ page, email: user.email });
  await startInPersonSession(page, { envelopeId: envelope.id, teamId: team.id });

  const device = page.context().request;

  // The host's other sign-ins cannot be listed or ended from the device.
  const authPost = async (path: string, data: unknown) =>
    await device.post(`${WEBAPP_BASE_URL}/api/auth/${path}`, {
      headers: { ...WEBAPP_ORIGIN_HEADERS, 'content-type': 'application/json' },
      data: JSON.stringify(data),
    });

  expect((await authPost('signout-all', {})).status()).toBe(403);
  expect((await authPost('signout-session', { sessionId: 'other-session' })).status()).toBe(403);
  expect((await device.get(`${WEBAPP_BASE_URL}/api/auth/sessions`, { headers: WEBAPP_ORIGIN_HEADERS })).status()).toBe(
    403,
  );

  // A maybe-authenticated procedure does not see the host either.
  const items = await trpcGet(
    device,
    'envelope.item.getManyByToken',
    { envelopeId: envelope.id, access: { type: 'user' } },
    team.id,
  );
  expect(items.ok()).toBe(false);
  expect(await items.text()).not.toContain('envelope_item_');

  // The in-person screens still work on the device.
  const view = await page.goto(
    `/in-person/${(await prisma.inPersonSigningSession.findFirstOrThrow({ where: { envelopeId: envelope.id, endedAt: null } })).id}`,
  );
  expect(view?.status()).toBe(200);
  await expect(page.getByTestId('in-person-host')).toBeVisible();
});

/* -------------------------------------------------------------------------- */
/*                                    S-L6                                    */
/* -------------------------------------------------------------------------- */

test('[S-L6]: rate-limit keys never hold a link token; scheduleSend refuses before writing', async ({ request }) => {
  const { envelope, recipients, token: apiToken } = await seedSigners(request, 1);
  const [signer] = recipients;

  // Token-keyed limits on public routes.
  await request.get(`${WEBAPP_BASE_URL}/api/files/token/${signer.token}/field-file/not-a-file`);
  await trpcPost(request, 'comment.postAsRecipient', { token: signer.token, body: 'Hello' });

  const rows = await prisma.rateLimit.findMany({ where: { key: { contains: signer.token } } });
  expect(rows).toHaveLength(0);

  // A non-draft document cannot be scheduled, and the request changes nothing on it.
  const before = await prisma.documentMeta.findFirstOrThrow({ where: { envelope: { id: envelope.id } } });

  const scheduled = await request.post(`${WEBAPP_BASE_URL}/api/v2-beta/envelope/schedule-send`, {
    headers: { Authorization: `Bearer ${apiToken}` },
    data: {
      envelopeId: envelope.id,
      localDateTime: '2099-01-01T10:00',
      timezone: 'America/New_York',
      meta: { redirectUrl: 'https://evil.test/phish', subject: 'Changed subject' },
    },
  });
  expect(scheduled.ok()).toBe(false);
  expect(await scheduled.text()).toContain('Only draft documents can be scheduled');

  const after = await prisma.documentMeta.findFirstOrThrow({ where: { envelope: { id: envelope.id } } });
  expect(after.redirectUrl).toBe(before.redirectUrl);
  expect(after.subject).toBe(before.subject);
  expect(
    await prisma.documentAuditLog.count({ where: { envelopeId: envelope.id, type: 'DOCUMENT_META_UPDATED' } }),
  ).toBe(0);
});

/* -------------------------------------------------------------------------- */
/*                          FINDINGS 13: disabled users                       */
/* -------------------------------------------------------------------------- */

test('[SEC2-L1]: rate-limit keys never hold a password-reset or verify-email token', async ({ request }) => {
  const resetToken = randomBytes(32).toString('hex');
  const verifyToken = randomBytes(32).toString('hex');

  const post = async (path: string, data: Record<string, string>) =>
    await request.post(`${WEBAPP_BASE_URL}/api/auth/email-password/${path}`, {
      headers: { ...WEBAPP_ORIGIN_HEADERS, 'content-type': 'application/json' },
      data: JSON.stringify(data),
    });

  // Unknown tokens: the requests fail, but each is counted by the limiter first.
  await post('reset-password', { token: resetToken, password: 'Unused-password-123!' });
  await post('verify-email', { token: verifyToken });

  for (const token of [resetToken, verifyToken]) {
    expect(await prisma.rateLimit.count({ where: { key: { contains: token } } })).toBe(0);

    // With rate limits bypassed (the usual e2e setting) nothing is counted; run this test with
    // DANGEROUS_BYPASS_RATE_LIMITS=false on the app and the tests to see the hashed key.
    if (process.env.DANGEROUS_BYPASS_RATE_LIMITS !== 'true') {
      const hashed = `token:${createHash('sha256').update(token).digest('hex').slice(0, 32)}`;
      expect(await prisma.rateLimit.count({ where: { key: { contains: hashed } } })).toBeGreaterThan(0);
    }
  }
});

test('[FINDINGS-13]: disabling a user ends their existing sessions', async ({ page }) => {
  const { user, team } = await seedUser();

  await apiSignin({ page, email: user.email });

  const before = await trpcGet(page.context().request, 'team.get', { teamReference: team.id }, team.id);
  expect(before.ok(), await before.text()).toBe(true);
  expect(await prisma.session.count({ where: { userId: user.id } })).toBeGreaterThan(0);

  await disableUser({ id: user.id });

  expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);

  const after = await trpcGet(page.context().request, 'team.get', { teamReference: team.id }, team.id);
  expect(after.status()).toBe(401);
});

/* -------------------------------------------------------------------------- */
/*                       S-L4 follow-up: save-time DNS check                   */
/* -------------------------------------------------------------------------- */

test('[S-L4]: a webhook hostname that resolves to a private address is refused when saved', async ({ page }) => {
  const { user, team } = await seedUser();
  await apiSignin({ page, email: user.email });

  for (const webhookUrl of ['http://localtest.me:8025/hook', 'http://no-such-host.invalid/hook']) {
    const response = await trpcPost(
      page.context().request,
      'webhook.createWebhook',
      { webhookUrl, eventTriggers: ['DOCUMENT_COMPLETED'], secret: null, enabled: true },
      team.id,
    );

    expect(response.ok(), webhookUrl).toBe(false);
  }

  expect(await prisma.webhook.count({ where: { teamId: team.id } })).toBe(0);
});

/* -------------------------------------------------------------------------- */
/*                 Backup codes and the email-link 2FA status code             */
/* -------------------------------------------------------------------------- */

test('[2FA]: a backup code works once, and a wrong code answers 401', async ({ browser }) => {
  const { user } = await seedUser();

  await setupTwoFactorAuthentication({ user });
  const withSecret = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  await enableTwoFactorAuthentication({ user: withSecret, code: await getCurrentTotpCode(user.id) });

  const enabled = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  const [backupCode] = getBackupCodes({ user: enabled }) ?? [];
  expect(backupCode).toBeTruthy();

  const context = await browser.newContext();

  const wrong = await authorizeEmailLink(context.request, {
    token: await createEmailLinkToken(user.id),
    totpCode: '000000',
  });
  expect(wrong.status()).toBe(401);

  const first = await context.request.post(`${WEBAPP_BASE_URL}/api/auth/email-link/authorize`, {
    headers: { ...WEBAPP_ORIGIN_HEADERS, 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.91' },
    data: JSON.stringify({ token: await createEmailLinkToken(user.id), backupCode }),
  });
  expect(first.status(), await first.text()).toBe(201);

  const second = await context.request.post(`${WEBAPP_BASE_URL}/api/auth/email-link/authorize`, {
    headers: { ...WEBAPP_ORIGIN_HEADERS, 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.92' },
    data: JSON.stringify({ token: await createEmailLinkToken(user.id), backupCode }),
  });
  expect(second.status()).toBe(401);

  const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  expect(getBackupCodes({ user: after })).not.toContain(backupCode);

  await context.close();
});

/* -------------------------------------------------------------------------- */
/*                 RT2-L3: the in-person turn ends with the action             */
/* -------------------------------------------------------------------------- */

test('[RT2-L3]: completing on the in-person device ends the turn at once and shows hand-back', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);

  const { envelope, user, team, recipients } = await seedSigners(request);
  const [first] = recipients;

  await apiSignin({ page, email: user.email });
  const sessionId = await startInPersonSession(page, { envelopeId: envelope.id, teamId: team.id });

  await handOverAndConfirm(page, sessionId, first.id, 'Signer 1');
  await expect(getPageCanvas(page)).toBeVisible({ timeout: 30_000 });

  await page.getByTestId('signature-pad-dialog-button').click();
  await page.getByRole('tab', { name: 'Type' }).click();
  await page.getByTestId('signature-pad-type-input').fill('Signature');
  await page.getByRole('button', { name: 'Next' }).click();

  const canvasBox = await getCanvasBox(page);
  await getPageCanvas(page).click({
    position: { x: (17.5 / 100) * canvasBox.width, y: (12.5 / 100) * canvasBox.height },
  });
  await expect(page.getByText('0 Fields Remaining').first()).toBeVisible({ timeout: 10_000 });

  const failedCalls: string[] = [];
  page.on('response', (response) => {
    if (response.url().includes('/api/trpc/') && response.status() >= 400) {
      failedCalls.push(`${response.status()} ${response.url()}`);
    }
  });

  const completed = page.waitForResponse((response) => response.url().includes('recipient.completeDocumentWithToken'));

  await page.getByRole('button', { name: 'Complete' }).click();
  await page.getByRole('button', { name: 'Sign' }).click();
  await completed;

  // The turn ended in the completing request itself.
  const session = await prisma.inPersonSigningSession.findUniqueOrThrow({ where: { id: sessionId } });
  expect(session.phase).toBe('HANDBACK');
  expect(session.turnToken).toBeNull();

  // The signer's page goes away at once and the hand-back screen follows.
  await expect(page.getByTestId('in-person-signing-bar')).toHaveCount(0, { timeout: 2_000 });
  await expect(page.getByTestId('in-person-handback')).toBeVisible({ timeout: 10_000 });

  // RT3-L1: the hand-back screen refreshes the session when the window gets focus; a locked
  // sign-in must not ask for the host's organisations (that answered 403).
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForTimeout(1_500);

  expect(failedCalls).toEqual([]);
});

/* -------------------------------------------------------------------------- */
/*                    Operations: server-wide daily caps                       */
/* -------------------------------------------------------------------------- */

test('[CAPS]: a reached server-wide cap is recorded once a day and shown in /api/health', async ({ request }) => {
  const bucket = getDailyQuotaBucket();
  await prisma.rateLimit.deleteMany({ where: { action: 'st.server-cap-reached', key: 'cap:SMS', bucket } });

  // Two senders hit the cap at once: one record, so one notice.
  await Promise.all([recordServerCapReached('SMS'), recordServerCapReached('SMS')]);

  expect(await prisma.rateLimit.count({ where: { action: 'st.server-cap-reached', key: 'cap:SMS', bucket } })).toBe(1);

  const health = await request.get(`${WEBAPP_BASE_URL}/api/health`);
  expect((await health.json()).capsReachedToday).toContain('SMS');

  await prisma.rateLimit.deleteMany({ where: { action: 'st.server-cap-reached', key: 'cap:SMS', bucket } });
});

/* -------------------------------------------------------------------------- */
/*            RT3-M1: server-wide notices go to the operators only             */
/* -------------------------------------------------------------------------- */

test('[RT3-M1]: the server-cap notice goes to instance admins, not every user or the service accounts', async () => {
  const { user: plainUser } = await seedUser();
  const { user: operator } = await seedUser({ isAdmin: true });
  const { user: disabledAdmin } = await seedUser({ isAdmin: true });
  await prisma.user.update({ where: { id: disabledAdmin.id }, data: { disabled: true } });

  const recipients = (await getServerOperatorRecipients()).map((recipient) => recipient.address);

  // Every signed-up user owns a personal organisation; that does not make them an operator.
  expect(recipients).toContain(operator.email);
  expect(recipients).not.toContain(plainUser.email);
  expect(recipients).not.toContain(disabledAdmin.email);
  expect(recipients.some((address) => /^(serviceaccount|deleted-account)@/.test(address))).toBe(false);
});

test('[HEALTH]: /api/health shows its detail only to monitoring, not to outside callers', async ({ request }) => {
  // Through the proxy (X-Forwarded-For set) and no token: the bare status only.
  const outside = await request.get(`${WEBAPP_BASE_URL}/api/health`, {
    headers: { 'x-forwarded-for': '203.0.113.77' },
  });
  const outsideBody = await outside.json();

  expect(outsideBody).toHaveProperty('status');
  expect(outsideBody).toHaveProperty('checks');
  expect(outsideBody).not.toHaveProperty('jobs');
  expect(outsideBody).not.toHaveProperty('capsReachedToday');
  expect(outsideBody).not.toHaveProperty('pdfQueue');

  // A direct local call (no proxy header) still gets the detail when no token is configured.
  const local = await (await request.get(`${WEBAPP_BASE_URL}/api/health`)).json();
  expect(local).toHaveProperty('jobs');
  expect(local).toHaveProperty('pdfQueue');
});

/* -------------------------------------------------------------------------- */
/*            RT3-L3: completion page wording for a download link             */
/* -------------------------------------------------------------------------- */

test('[RT3-L3]: the completion page says "download" when the signed copy comes as a link', async ({
  page,
  request,
}) => {
  const { envelope, recipients } = await seedSigners(request);
  const [first] = recipients;

  await prisma.field.updateMany({ where: { recipientId: first.id }, data: { inserted: true, customText: 'Signed' } });
  await completeDocumentWithToken({ token: first.token, id: { type: 'envelopeId', id: envelope.id } });

  // A small document goes as an attachment: the old wording stays.
  await page.goto(`/sign/${first.token}/complete`);
  await expect(
    page.getByText('You will receive an email copy of the signed document once everyone has signed.'),
  ).toBeVisible();

  // The completion email for this signer went (or goes) as a link.
  await prisma.documentAuditLog.create({
    data: {
      envelopeId: envelope.id,
      type: 'EMAIL_SENT',
      email: first.email,
      data: {
        emailType: 'DOCUMENT_COMPLETED',
        recipientEmail: first.email,
        recipientName: first.name,
        recipientId: first.id,
        recipientRole: 'SIGNER',
        isResending: false,
        documentDelivery: 'LINK',
      },
    },
  });

  await page.reload();
  await expect(page.getByText('you will get an email with a link to download your signed copy')).toBeVisible();
  await expect(page.getByText('You will receive an email copy of the signed document')).toHaveCount(0);
});
