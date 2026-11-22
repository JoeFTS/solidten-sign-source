/**
 * Regression tests for the 11/21 audit round, builder A (sign-in, signer links,
 * in-person). Each test reproduces the verifier's steps and fails on
 * `solidten/main` before the fix.
 */
import { randomUUID } from 'node:crypto';
import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { DOCUMENSO_ENCRYPTION_KEY } from '@documenso/lib/constants/crypto';
import { generateTwoFactorTokenFromEmail } from '@documenso/lib/server-only/2fa/email/generate-2fa-token-from-email';
import { enableTwoFactorAuthentication } from '@documenso/lib/server-only/2fa/enable-2fa';
import { setupTwoFactorAuthentication } from '@documenso/lib/server-only/2fa/setup-2fa';
import { symmetricDecrypt } from '@documenso/lib/universal/crypto';
import { mapSecondaryIdToDocumentId } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';
import { seedTeamMember } from '@documenso/prisma/seed/teams';
import { seedUser } from '@documenso/prisma/seed/users';
import type { APIRequestContext, Browser } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { base32 } from '@scure/base';
import { generateHOTP } from 'oslo/otp';

import { apiSeedPendingDocument } from '../fixtures/api-seeds';
import { apiSignin, WEBAPP_ORIGIN_HEADERS } from '../fixtures/authentication';

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();

test.describe.configure({ mode: 'parallel' });

const uniqueEmail = (label: string) =>
  `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.documenso.com`;

const trpcPost = async (
  requestContext: APIRequestContext,
  path: string,
  input: unknown,
  headers: Record<string, string> = {},
) =>
  await requestContext.post(`${WEBAPP_BASE_URL}/api/trpc/${path}`, {
    headers: { ...WEBAPP_ORIGIN_HEADERS, 'content-type': 'application/json', ...headers },
    data: JSON.stringify({ json: input }),
  });

/** One GET request that carries several calls of the same query (a tRPC batch). */
const trpcBatchGet = async (
  requestContext: APIRequestContext,
  path: string,
  inputs: unknown[],
  headers: Record<string, string> = {},
) => {
  const input = JSON.stringify(Object.fromEntries(inputs.map((value, index) => [String(index), { json: value }])));

  return await requestContext.get(
    `${WEBAPP_BASE_URL}/api/trpc/${inputs.map(() => path).join(',')}?batch=1&input=${encodeURIComponent(input)}`,
    { headers: { ...WEBAPP_ORIGIN_HEADERS, ...headers } },
  );
};

const PIN = '4826';

const trpcGet = async (requestContext: APIRequestContext, path: string, input: unknown, teamId?: number) =>
  await requestContext.get(
    `${WEBAPP_BASE_URL}/api/trpc/${path}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`,
    { headers: { ...WEBAPP_ORIGIN_HEADERS, ...(teamId ? { 'x-team-id': String(teamId) } : {}) } },
  );

/** A signed-in browser of the host (its own cookie jar). */
const signedInHost = async (browser: Browser, email: string) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await apiSignin({ page, email });

  return { context, page, request: context.request };
};

const startInPerson = async (device: APIRequestContext, envelopeId: string, teamId: number) => {
  const response = await trpcPost(
    device,
    'inPerson.start',
    { envelopeId, pin: PIN, emailCodeRecipientIds: [] },
    { 'x-team-id': String(teamId) },
  );

  expect(response.ok(), await response.text()).toBe(true);

  return (await response.json()).result.data.json.sessionId as string;
};

const seedEmailCodeSigner = async (request: APIRequestContext, accessAuth: string[] = ['TWO_FACTOR_AUTH']) => {
  const seeded = await apiSeedPendingDocument(request, {
    title: '[TEST] Audit A',
    recipients: [{ email: uniqueEmail('code-signer'), name: 'Code Signer', accessAuth }],
  });

  const recipient = await prisma.recipient.findFirstOrThrow({ where: { envelopeId: seeded.envelope.id } });

  // No fields to fill: the access code is the only thing between the link and "signed".
  await prisma.field.deleteMany({ where: { recipientId: recipient.id } });

  return {
    ...seeded,
    recipient,
    documentId: mapSecondaryIdToDocumentId(seeded.envelope.secondaryId),
  };
};

const completeWithCode = (documentId: number, token: string, code: string) => ({
  token,
  documentId,
  accessAuthOptions: { type: 'TWO_FACTOR_AUTH', token: code, method: 'email' },
});

/* -------------------------------------------------------------------------- */
/*                                    AUD-1                                   */
/* -------------------------------------------------------------------------- */

test('[AUD-1]: wrong emailed access codes lock the code until a new one is requested', async ({ request }) => {
  const { envelope, recipient, documentId } = await seedEmailCodeSigner(request);

  // Eight wrong guesses at once, in parallel requests (each its own address).
  const wrong = await Promise.all(
    Array.from({ length: 8 }, async (_, index) =>
      trpcPost(
        request,
        'recipient.completeDocumentWithToken',
        completeWithCode(documentId, recipient.token, `00000${index}`),
        { 'x-forwarded-for': `198.51.102.${index + 1}` },
      ),
    ),
  );

  expect(wrong.every((response) => !response.ok())).toBe(true);

  // The right code is refused now: the code is locked.
  const rightCode = await generateTwoFactorTokenFromEmail({ envelopeId: envelope.id, email: recipient.email });
  const locked = await trpcPost(
    request,
    'recipient.completeDocumentWithToken',
    completeWithCode(documentId, recipient.token, rightCode),
  );

  expect(locked.ok()).toBe(false);
  expect(await locked.text()).toContain('TOO_MANY_REQUESTS');

  const stillUnsigned = await prisma.recipient.findUniqueOrThrow({ where: { id: recipient.id } });
  expect(stillUnsigned.signingStatus).toBe('NOT_SIGNED');

  const lockedRows = await prisma.documentAuditLog.count({
    where: { envelopeId: envelope.id, type: 'DOCUMENT_ACCESS_AUTH_2FA_LOCKED' },
  });
  expect(lockedRows).toBe(1);

  // A new code request unlocks it, and the right code then signs.
  const requested = await trpcPost(request, 'document.accessAuth.request2FAEmail', { token: recipient.token });
  expect(requested.ok(), await requested.text()).toBe(true);

  const freshCode = await generateTwoFactorTokenFromEmail({ envelopeId: envelope.id, email: recipient.email });
  const signed = await trpcPost(
    request,
    'recipient.completeDocumentWithToken',
    completeWithCode(documentId, recipient.token, freshCode),
  );

  expect(signed.ok(), await signed.text()).toBe(true);

  const after = await prisma.recipient.findUniqueOrThrow({ where: { id: recipient.id } });
  expect(after.signingStatus).toBe('SIGNED');
});

/* -------------------------------------------------------------------------- */
/*                                   AUD-15                                   */
/* -------------------------------------------------------------------------- */

test('[AUD-15]: a tRPC batch is capped at 20 calls', async ({ request }) => {
  const { recipient } = await seedEmailCodeSigner(request);
  const input = { token: recipient.token };
  const headers = { 'x-forwarded-for': '198.51.103.1' };

  const atCap = await trpcBatchGet(request, 'lifecycle.getSigningLinkStatus', Array(20).fill(input), headers);
  expect(atCap.status(), await atCap.text()).toBe(200);

  const overCap = await trpcBatchGet(request, 'lifecycle.getSigningLinkStatus', Array(21).fill(input), headers);
  expect(overCap.status()).toBe(400);
});

test('[AUD-15]: every call in a batch is charged to the rate limit', async ({ request }) => {
  test.skip(process.env.DANGEROUS_BYPASS_RATE_LIMITS === 'true', 'Rate limits are bypassed');

  const { recipient } = await seedEmailCodeSigner(request);
  const input = { token: recipient.token };
  const headers = { 'x-forwarded-for': `198.51.103.${2 + Math.floor(Math.random() * 200)}` };

  const first = await trpcBatchGet(request, 'lifecycle.getSigningLinkStatus', [input], headers);
  const before = Number(first.headers()['x-ratelimit-remaining']);

  const batch = await trpcBatchGet(request, 'lifecycle.getSigningLinkStatus', Array(10).fill(input), headers);
  const after = Number(batch.headers()['x-ratelimit-remaining']);

  expect(before - after).toBe(10);
});

test('[AUD-15 low]: only a real signing link gets the per-link rate budget', async ({ request }) => {
  const { recipient } = await seedEmailCodeSigner(request);
  const headers = { 'x-forwarded-for': `198.51.104.${1 + Math.floor(Math.random() * 200)}` };

  const real = await trpcBatchGet(request, 'lifecycle.getSigningLinkStatus', [{ token: recipient.token }], headers);
  expect(real.ok()).toBe(true);
  expect(real.headers()['x-ratelimit-limit']).not.toBe('100');

  // An invented token is charged to the anonymous 100-per-minute IP key.
  const invented = await trpcBatchGet(
    request,
    'lifecycle.getSigningLinkStatus',
    [{ token: `invented-${Date.now()}-${Math.random().toString(36).slice(2)}` }],
    headers,
  );
  expect(invented.headers()['x-ratelimit-limit']).toBe('100');
});

/* -------------------------------------------------------------------------- */
/*                                    AUD-3                                   */
/* -------------------------------------------------------------------------- */

test('[AUD-3]: ending in-person signing from another browser signs the device out', async ({ browser, request }) => {
  const { envelope, user, team } = await seedEmailCodeSigner(request, []);

  const device = await signedInHost(browser, user.email);
  const other = await signedInHost(browser, user.email);

  const sessionId = await startInPerson(device.request, envelope.id, team.id);
  const { authSessionId } = await prisma.inPersonSigningSession.findUniqueOrThrow({ where: { id: sessionId } });

  // Locked while it runs.
  expect((await trpcGet(device.request, 'apiToken.getMany', undefined, team.id)).ok()).toBe(false);

  const ended = await trpcPost(
    other.request,
    'inPerson.endForEnvelope',
    { envelopeId: envelope.id },
    { 'x-team-id': String(team.id) },
  );
  expect(ended.ok(), await ended.text()).toBe(true);

  // The device does not get the host's account back.
  const tokens = await trpcGet(device.request, 'apiToken.getMany', undefined, team.id);
  expect(tokens.status()).toBe(401);
  expect(await prisma.session.count({ where: { id: authSessionId } })).toBe(0);

  await device.page.goto('/settings/profile');
  await expect(device.page).toHaveURL(/\/signin/);

  // The other sign-in still works.
  expect((await trpcGet(other.request, 'apiToken.getMany', undefined, team.id)).ok()).toBe(true);

  await device.context.close();
  await other.context.close();
});

test('[AUD-3]: an expired in-person session signs the device out, from the first request on', async ({
  browser,
  request,
}) => {
  const { envelope, user, team } = await seedEmailCodeSigner(request, []);

  const device = await signedInHost(browser, user.email);

  const sessionId = await startInPerson(device.request, envelope.id, team.id);
  const { authSessionId } = await prisma.inPersonSigningSession.findUniqueOrThrow({ where: { id: sessionId } });

  await prisma.inPersonSigningSession.update({
    where: { id: sessionId },
    data: { expiresAt: new Date(Date.now() - 60_000) },
  });

  // The request that finds the expiry is refused too, and so is every later one.
  const first = await trpcGet(device.request, 'apiToken.getMany', undefined, team.id);
  expect(first.ok()).toBe(false);

  const second = await trpcGet(device.request, 'apiToken.getMany', undefined, team.id);
  expect(second.status()).toBe(401);

  const ended = await prisma.inPersonSigningSession.findUniqueOrThrow({ where: { id: sessionId } });
  expect(ended.endReason).toBe('EXPIRED');
  expect(await prisma.session.count({ where: { id: authSessionId } })).toBe(0);

  await device.page.goto('/settings/profile');
  await expect(device.page).toHaveURL(/\/signin/);

  await device.context.close();
});

test('[AUD-3 follow-up 2]: a locked device is signed out when its in-person row goes away', async ({
  browser,
  request,
}) => {
  const { envelope, user, team } = await seedEmailCodeSigner(request, []);

  const device = await signedInHost(browser, user.email);

  const sessionId = await startInPerson(device.request, envelope.id, team.id);
  const { authSessionId } = await prisma.inPersonSigningSession.findUniqueOrThrow({ where: { id: sessionId } });

  expect((await trpcGet(device.request, 'apiToken.getMany', undefined, team.id)).ok()).toBe(false);

  // A privileged user deletes the pending document: the cascade removes the in-person row.
  await prisma.envelope.delete({ where: { id: envelope.id } });
  expect(await prisma.inPersonSigningSession.count({ where: { id: sessionId } })).toBe(0);

  // The device never becomes the host: the first call is refused, the sign-in is gone.
  const mint = await trpcPost(
    device.request,
    'apiToken.create',
    { teamId: team.id, tokenName: 'after-delete', expirationDate: null },
    { 'x-team-id': String(team.id) },
  );
  expect(mint.ok()).toBe(false);
  expect(await prisma.apiToken.count({ where: { name: 'after-delete', userId: user.id } })).toBe(0);

  expect(await prisma.session.count({ where: { id: authSessionId } })).toBe(0);
  expect((await trpcGet(device.request, 'apiToken.getMany', undefined, team.id)).status()).toBe(401);

  await device.page.goto('/settings/profile');
  await expect(device.page).toHaveURL(/\/signin/);

  await device.context.close();
});

const RACE_ROUNDS = 15;
const RACE_REQUESTS = 8;

/**
 * Fire `end` together with host-only calls from the locked device, staggered by 0-14 ms,
 * and count the calls that ran as the host.
 */
const raceHostCalls = async (device: APIRequestContext, teamId: number, label: string, end: () => Promise<unknown>) => {
  const sleep = async (ms: number) => await new Promise((resolve) => setTimeout(resolve, ms));

  const calls = Array.from({ length: RACE_REQUESTS }, async (_, index) => {
    await sleep(index * 2);

    return await trpcPost(
      device,
      'apiToken.create',
      { teamId, tokenName: `race-${label}-${index}`, expirationDate: null },
      { 'x-team-id': String(teamId) },
    );
  });

  const [, ...responses] = await Promise.all([end(), ...calls]);

  return responses.filter((response) => response.ok()).length;
};

test('[AUD-3 race]: a device call racing a PIN-less end never runs as the host', async ({ browser, request }) => {
  test.setTimeout(420_000);

  const { envelope, user, team } = await seedEmailCodeSigner(request, []);
  const other = await signedInHost(browser, user.email);

  let hostSuccesses = 0;

  for (let round = 0; round < RACE_ROUNDS; round++) {
    // Ended from another browser (forgotten PIN, device left behind).
    const byOther = await signedInHost(browser, user.email);
    await startInPerson(byOther.request, envelope.id, team.id);

    hostSuccesses += await raceHostCalls(byOther.request, team.id, `elsewhere-${round}`, async () =>
      trpcPost(other.request, 'inPerson.endForEnvelope', { envelopeId: envelope.id }, { 'x-team-id': String(team.id) }),
    );

    await byOther.context.close();

    // Ended by the device holder's fifth wrong PIN.
    const byPin = await signedInHost(browser, user.email);
    const sessionId = await startInPerson(byPin.request, envelope.id, team.id);

    for (let attempt = 0; attempt < 4; attempt++) {
      await trpcPost(byPin.request, 'inPerson.exit', { sessionId, pin: '0000' });
    }

    hostSuccesses += await raceHostCalls(byPin.request, team.id, `pin-${round}`, async () =>
      trpcPost(byPin.request, 'inPerson.exit', { sessionId, pin: '0000' }),
    );

    await byPin.context.close();
  }

  console.log(`[AUD-3 race] ${hostSuccesses} of ${RACE_ROUNDS * 2 * RACE_REQUESTS} racing calls ran as the host`);

  expect(hostSuccesses).toBe(0);
  expect(await prisma.apiToken.count({ where: { name: { startsWith: 'race-' }, userId: user.id } })).toBe(0);

  await other.context.close();
});

/* -------------------------------------------------------------------------- */
/*                                   AUD-11                                   */
/* -------------------------------------------------------------------------- */

test('[AUD-11]: a sign-in locked for in-person signing cannot mint an embed session', async ({ browser, request }) => {
  const { envelope, user, team } = await seedEmailCodeSigner(request, []);

  const device = await signedInHost(browser, user.email);
  await startInPerson(device.request, envelope.id, team.id);

  const nonce = randomUUID();
  const authHeaders = { ...WEBAPP_ORIGIN_HEADERS, 'content-type': 'application/json' };

  const start = await device.request.post(`${WEBAPP_BASE_URL}/api/auth/embed/start`, {
    headers: authHeaders,
    data: JSON.stringify({ nonce, provider: 'account' }),
  });
  expect(start.ok(), await start.text()).toBe(true);

  const { returnTo } = (await start.json()) as { returnTo: string };

  const complete = await device.request.get(`${WEBAPP_BASE_URL}${returnTo}`, { maxRedirects: 0 });
  expect(complete.headers().location).toContain('status=error');

  // Someone else holding the nonce gets no session for the host.
  const elsewhere = await browser.newContext();
  const redeem = await elsewhere.request.post(`${WEBAPP_BASE_URL}/api/auth/embed/redeem`, {
    headers: authHeaders,
    data: JSON.stringify({ nonce }),
  });
  expect(await redeem.text()).not.toContain('"ok"');
  expect(await prisma.session.count({ where: { userId: user.id, isEmbed: true } })).toBe(0);

  await elsewhere.close();
  await device.context.close();
});

/* -------------------------------------------------------------------------- */
/*                         In-person endForEnvelope (low)                     */
/* -------------------------------------------------------------------------- */

test('[IP-END low]: only a host may end in-person signing elsewhere, and the audit names who did', async ({
  browser,
  request,
}) => {
  const { envelope, user, team } = await seedEmailCodeSigner(request, []);

  const device = await signedInHost(browser, user.email);
  const sessionId = await startInPerson(device.request, envelope.id, team.id);

  // A plain member who can see the document cannot end it.
  const member = await seedTeamMember({ teamId: team.id, role: 'MEMBER' });
  const memberBrowser = await signedInHost(browser, member.email);

  const byMember = await trpcPost(
    memberBrowser.request,
    'inPerson.endForEnvelope',
    { envelopeId: envelope.id },
    { 'x-team-id': String(team.id) },
  );
  expect(byMember.ok()).toBe(false);
  expect(await byMember.text()).toContain('Only the document owner or a team admin or manager');

  const stillRunning = await prisma.inPersonSigningSession.findUniqueOrThrow({ where: { id: sessionId } });
  expect(stillRunning.endedAt).toBeNull();

  // A team admin can, and the audit entry names the admin, not the host.
  const admin = await seedTeamMember({ teamId: team.id, role: 'ADMIN' });
  const adminBrowser = await signedInHost(browser, admin.email);

  const byAdmin = await trpcPost(
    adminBrowser.request,
    'inPerson.endForEnvelope',
    { envelopeId: envelope.id },
    { 'x-team-id': String(team.id) },
  );
  expect(byAdmin.ok(), await byAdmin.text()).toBe(true);

  const entry = await prisma.documentAuditLog.findFirstOrThrow({
    where: { envelopeId: envelope.id, type: 'IN_PERSON_SESSION_ENDED' },
  });
  expect(entry.userId).toBe(admin.id);
  expect(entry.email).toBe(admin.email);
  expect(entry.data).toMatchObject({ hostUserId: user.id, endedByUserId: admin.id, reason: 'ENDED_ELSEWHERE' });

  await memberBrowser.context.close();
  await adminBrowser.context.close();
  await device.context.close();
});

/* -------------------------------------------------------------------------- */
/*                                    AUD-6                                   */
/* -------------------------------------------------------------------------- */

const ACCOUNT_REQUIRED = 'Sign in with the account this document was sent to';

test('[AUD-6]: a decoy token key does not skip the account check', async ({ request }) => {
  const { envelope, recipient } = await seedEmailCodeSigner(request, ['ACCOUNT']);
  const decoy = 'decoy-not-a-recipient-token';

  // fieldFile.upload: a decoy `token` part before the real token in the payload.
  const form = new FormData();
  form.append('token', decoy);
  form.append('payload', JSON.stringify({ token: recipient.token, fieldId: 1 }));
  form.append('file', new File([Buffer.from('%PDF-1.4 test')], 'proof.pdf', { type: 'application/pdf' }));

  const upload = await request.post(`${WEBAPP_BASE_URL}/api/trpc/fieldFile.upload`, {
    headers: WEBAPP_ORIGIN_HEADERS,
    multipart: form,
  });
  expect(upload.status()).toBe(401);
  expect(await upload.text()).toContain(ACCOUNT_REQUIRED);

  // envelope.item.getManyByToken: a decoy top-level `token` beside access.token.
  const items = await trpcGet(request, 'envelope.item.getManyByToken', {
    token: decoy,
    envelopeId: envelope.id,
    access: { type: 'recipient', token: recipient.token },
  });
  expect(items.status()).toBe(401);
  expect(await items.text()).not.toContain('envelope_item_');
});

test('[AUD-6]: a two-factor code in authOptions is not read as a second link token', async ({ request }) => {
  const seeded = await apiSeedPendingDocument(request, {
    title: '[TEST] Audit A 2FA option',
    recipients: [{ email: uniqueEmail('plain-signer'), name: 'Plain Signer' }],
  });

  const recipient = await prisma.recipient.findFirstOrThrow({ where: { envelopeId: seeded.envelope.id } });
  const field = await prisma.field.findFirstOrThrow({ where: { recipientId: recipient.id, type: 'SIGNATURE' } });

  const signed = await trpcPost(request, 'field.signFieldWithToken', {
    token: recipient.token,
    fieldId: field.id,
    value: 'Plain Signer',
    authOptions: { type: 'TWO_FACTOR_AUTH', token: '123456' },
  });

  expect(signed.ok(), await signed.text()).toBe(true);
  expect((await prisma.field.findUniqueOrThrow({ where: { id: field.id } })).inserted).toBe(true);
});

/* -------------------------------------------------------------------------- */
/*                                   AUD-14                                   */
/* -------------------------------------------------------------------------- */

test('[AUD-14]: declining by link needs the emailed access code', async ({ request }) => {
  const { envelope, recipient, documentId } = await seedEmailCodeSigner(request);
  const decline = (extra: Record<string, unknown> = {}) =>
    trpcPost(request, 'recipient.rejectDocumentWithToken', {
      token: recipient.token,
      documentId,
      reason: 'Not me',
      ...extra,
    });

  const withoutCode = await decline();
  expect(withoutCode.ok()).toBe(false);

  const wrongCode = await decline({ accessAuthOptions: { type: 'TWO_FACTOR_AUTH', token: '000000', method: 'email' } });
  expect(wrongCode.ok()).toBe(false);
  expect(await wrongCode.text()).toContain('TWO_FACTOR_AUTH_FAILED');

  expect((await prisma.recipient.findUniqueOrThrow({ where: { id: recipient.id } })).signingStatus).toBe('NOT_SIGNED');
  expect((await prisma.envelope.findUniqueOrThrow({ where: { id: envelope.id } })).status).toBe('PENDING');

  const rightCode = await generateTwoFactorTokenFromEmail({ envelopeId: envelope.id, email: recipient.email });
  const declined = await decline({ accessAuthOptions: { type: 'TWO_FACTOR_AUTH', token: rightCode, method: 'email' } });
  expect(declined.ok(), await declined.text()).toBe(true);

  expect((await prisma.recipient.findUniqueOrThrow({ where: { id: recipient.id } })).signingStatus).toBe('REJECTED');
});

/* -------------------------------------------------------------------------- */
/*                                   AUD-12                                   */
/* -------------------------------------------------------------------------- */

const currentTotpCode = async (userId: number) => {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

  if (!DOCUMENSO_ENCRYPTION_KEY || !user.twoFactorSecret) {
    throw new Error('Expected encryption key and 2FA secret');
  }

  const secret = Buffer.from(symmetricDecrypt({ key: DOCUMENSO_ENCRYPTION_KEY, data: user.twoFactorSecret })).toString(
    'utf-8',
  );

  return await generateHOTP(base32.decode(secret), Math.floor(Date.now() / 30_000));
};

test('[AUD-12]: the 2FA setup routes cannot turn off 2FA that is on', async ({ page }) => {
  const { user } = await seedUser();

  // A signed-in session of the user (taken before 2FA is on; it stays valid).
  await apiSignin({ page, email: user.email });

  await setupTwoFactorAuthentication({ user });
  const withSecret = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  await enableTwoFactorAuthentication({ user: withSecret, code: await currentTotpCode(user.id) });

  const before = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  expect(before.twoFactorEnabled).toBe(true);

  // The session, with no code, calls both setup doors.
  for (const path of ['two-factor/setup', 'email-password/2fa/setup']) {
    const response = await page.context().request.post(`${WEBAPP_BASE_URL}/api/auth/${path}`, {
      headers: { ...WEBAPP_ORIGIN_HEADERS, 'content-type': 'application/json' },
      data: '{}',
    });

    expect(response.ok(), `${path}: ${await response.text()}`).toBe(false);
  }

  const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  expect(after.twoFactorEnabled).toBe(true);
  expect(after.twoFactorSecret).toBe(before.twoFactorSecret);
  expect(after.twoFactorBackupCodes).toBe(before.twoFactorBackupCodes);
});

/* -------------------------------------------------------------------------- */
/*                     Sign-in kill switch in onAuthorize (low)               */
/* -------------------------------------------------------------------------- */

test('[KILL-SWITCH low]: with sign-in turned off, verifying an email does not sign in', async ({ request }) => {
  test.skip(process.env.NEXT_PUBLIC_DISABLE_SIGNIN !== 'true', 'Needs a server with NEXT_PUBLIC_DISABLE_SIGNIN=true');

  const { user } = await seedUser({ verified: false });
  const token = `verify-${randomUUID()}`;

  await prisma.verificationToken.create({
    data: {
      userId: user.id,
      identifier: 'confirmation-email',
      token,
      expires: new Date(Date.now() + 60 * 60_000),
    },
  });

  const response = await request.post(`${WEBAPP_BASE_URL}/api/auth/email-password/verify-email`, {
    headers: { ...WEBAPP_ORIGIN_HEADERS, 'content-type': 'application/json' },
    data: JSON.stringify({ token }),
  });

  expect(await response.text()).toContain('VERIFIED');
  expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).emailVerified).not.toBeNull();
  expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
});
