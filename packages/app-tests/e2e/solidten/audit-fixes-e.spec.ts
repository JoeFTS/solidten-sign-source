import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { DOCUMENSO_ENCRYPTION_KEY } from '@documenso/lib/constants/crypto';
import { enableTwoFactorAuthentication } from '@documenso/lib/server-only/2fa/enable-2fa';
import { setupTwoFactorAuthentication } from '@documenso/lib/server-only/2fa/setup-2fa';
import { completeDocumentWithToken } from '@documenso/lib/server-only/document/complete-document-with-token';
import { createDocumentFromDirectTemplate } from '@documenso/lib/server-only/template/create-document-from-direct-template';
import { symmetricDecrypt } from '@documenso/lib/universal/crypto';
import type { ApiRequestMetadata } from '@documenso/lib/universal/extract-request-metadata';
import { mapSecondaryIdToDocumentId } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';
import { DocumentSigningOrder, FieldType, RecipientRole, SendStatus, SigningStatus } from '@documenso/prisma/client';
import { seedPendingDocumentWithFullFields } from '@documenso/prisma/seed/documents';
import { seedDirectTemplate } from '@documenso/prisma/seed/templates';
import { seedUser } from '@documenso/prisma/seed/users';
import type { APIRequestContext, Browser, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { base32 } from '@scure/base';
import { generateHOTP } from 'oslo/otp';

import { apiSignin, WEBAPP_ORIGIN_HEADERS } from '../fixtures/authentication';

/**
 * Solid Ten: regression tests for the 11/21 audit follow-ups (builder E).
 *
 * AUD-C4 follow-up: on a plain direct link, only the address that an unverified visitor typed is
 * not mailed. The recipients the owner set in the template and the owner notices keep working.
 * These tests read the mail sink (Mailpit), so they need E2E_MAIL_SINK_URL.
 */

test.describe.configure({ mode: 'serial' });

const MAIL_SINK_URL = process.env.E2E_MAIL_SINK_URL;

const uniqueEmail = (label: string) => `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@audit-e.test`;

const sleep = async (ms: number) => await new Promise((resolve) => setTimeout(resolve, ms));

const requestMetadata: ApiRequestMetadata = { requestMetadata: {}, source: 'app', auth: null };

/** The owner's Resend (envelope.redistribute), as the web app calls it. */
const redistribute = async (page: Page, teamId: number, envelopeId: string, recipients: number[]) =>
  await page.context().request.post(`${NEXT_PUBLIC_WEBAPP_URL()}/api/trpc/envelope.redistribute`, {
    headers: { ...WEBAPP_ORIGIN_HEADERS, 'content-type': 'application/json', 'x-team-id': String(teamId) },
    data: JSON.stringify({ json: { envelopeId, recipients } }),
  });

const mailSubjectsTo = async (to: string) => {
  const res = await fetch(`${MAIL_SINK_URL}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
  const body = (await res.json()) as { messages?: { Subject: string }[] };

  return (body.messages ?? []).map((message) => message.Subject);
};

/** Wait until `to` has a mail whose subject matches, or give up after `timeoutMs`. */
const waitForMail = async (to: string, subject: RegExp, timeoutMs = 45_000) => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if ((await mailSubjectsTo(to)).some((candidate) => subject.test(candidate))) {
      return true;
    }

    await sleep(500);
  }

  return false;
};

/**
 * A version-1 direct template (no public form row). The direct slot signs first. `later` adds a
 * fixed recipient that the owner set: a SIGNER at order 2 (sequential) or a CC.
 */
const seedPlainDirectTemplate = async (later: 'SIGNER' | 'CC') => {
  const { user: owner, team } = await seedUser();

  const template = await seedDirectTemplate({ title: '[TEST] Audit E direct link', userId: owner.id, teamId: team.id });

  await prisma.documentMeta.update({
    where: { id: template.documentMetaId },
    data: { signingOrder: DocumentSigningOrder.SEQUENTIAL },
  });

  const envelopeItem = await prisma.envelopeItem.findFirstOrThrow({ where: { envelopeId: template.id } });
  const laterEmail = uniqueEmail(later === 'SIGNER' ? 'fixed-signer' : 'fixed-cc');

  const laterRecipient = await prisma.recipient.create({
    data: {
      envelopeId: template.id,
      email: laterEmail,
      name: later === 'SIGNER' ? 'Fixed Signer' : 'Fixed Copy',
      token: Math.random().toString().slice(2, 12),
      role: later === 'SIGNER' ? RecipientRole.SIGNER : RecipientRole.CC,
      signingOrder: 2,
    },
  });

  if (later === 'SIGNER') {
    await prisma.field.create({
      data: {
        envelopeId: template.id,
        envelopeItemId: envelopeItem.id,
        recipientId: laterRecipient.id,
        type: FieldType.SIGNATURE,
        page: 1,
        positionX: 5,
        positionY: 40,
        width: 20,
        height: 5,
        customText: '',
        inserted: false,
      },
    });
  }

  const directSignatureField = template.fields.find((field) => field.type === FieldType.SIGNATURE);

  if (!template.directLink || !directSignatureField) {
    throw new Error('Seeded direct template is missing its link or signature field');
  }

  const refreshed = await prisma.envelope.findFirstOrThrow({ where: { id: template.id } });

  return {
    owner,
    teamId: team.id,
    laterEmail,
    token: template.directLink.token,
    fieldId: directSignatureField.id,
    templateUpdatedAt: refreshed.updatedAt,
  };
};

const submit = async (
  seeded: Awaited<ReturnType<typeof seedPlainDirectTemplate>>,
  options: { email: string; user?: { id: number; name?: string; email: string } },
) =>
  await createDocumentFromDirectTemplate({
    directRecipientName: 'Visitor',
    directRecipientEmail: options.email,
    directTemplateToken: seeded.token,
    templateUpdatedAt: seeded.templateUpdatedAt,
    signedFieldValues: [{ token: seeded.token, fieldId: seeded.fieldId, value: 'Typed Signature', isBase64: false }],
    user: options.user,
    requestMetadata,
  });

const requireMailSink = () => test.skip(!MAIL_SINK_URL, 'E2E_MAIL_SINK_URL is not set');

test('[AUD-C4 follow-up]: an anonymous visitor does not stop the fixed signer or the owner notices', async () => {
  requireMailSink();
  const seeded = await seedPlainDirectTemplate('SIGNER');
  const typed = uniqueEmail('visitor');

  const { envelopeId, recipientId } = await submit(seeded, { email: typed });

  // Point 4: the owner gets "Document created from direct template".
  expect(await waitForMail(seeded.owner.email, /^Document created from direct template$/)).toBe(true);

  // Point 3: the signer the owner set gets the signing request.
  expect(await waitForMail(seeded.laterEmail, /invited you to sign/)).toBe(true);

  const fixed = await prisma.recipient.findFirstOrThrow({
    where: { envelopeId, email: seeded.laterEmail },
    include: { fields: true },
  });
  expect(fixed.sendStatus).toBe(SendStatus.SENT);
  expect(fixed.unverifiedEmailAt).toBeNull();

  // The fixed signer signs and completes.
  for (const field of fixed.fields) {
    await prisma.field.update({ where: { id: field.id }, data: { inserted: true } });
    await prisma.signature.create({ data: { fieldId: field.id, recipientId: fixed.id, typedSignature: 'Fixed' } });
  }

  await completeDocumentWithToken({
    token: fixed.token,
    id: { type: 'envelopeId', id: envelopeId },
    requestMetadata: { userAgent: 'audit-e' },
  });

  // Point 4: the owner gets "has signed" and the signed copy; point 3: so does the fixed signer.
  expect(await waitForMail(seeded.owner.email, /has signed/)).toBe(true);
  expect(await waitForMail(seeded.owner.email, /^Signing Complete!$/, 90_000)).toBe(true);
  expect(await waitForMail(seeded.laterEmail, /^Signing Complete!$/)).toBe(true);

  // Point 1: nothing at all went to the typed address.
  await sleep(3_000);
  expect(await mailSubjectsTo(typed)).toEqual([]);

  // The visitor's signing counts, and only the typed address is marked.
  const direct = await prisma.recipient.findUniqueOrThrow({ where: { id: recipientId } });
  expect(direct.signingStatus).toBe(SigningStatus.SIGNED);
  expect(direct.unverifiedEmailAt).toBeInstanceOf(Date);
});

test('[AUD-C4 follow-up]: the owner resend reaches the fixed signer and refuses the unverified address', async ({
  page,
}) => {
  requireMailSink();
  const seeded = await seedPlainDirectTemplate('SIGNER');
  const typed = uniqueEmail('visitor');

  const { envelopeId, recipientId } = await submit(seeded, { email: typed });
  const fixed = await prisma.recipient.findFirstOrThrow({ where: { envelopeId, email: seeded.laterEmail } });

  expect(await waitForMail(seeded.laterEmail, /.+/)).toBe(true);
  const before = (await mailSubjectsTo(seeded.laterEmail)).length;

  await apiSignin({ page, email: seeded.owner.email });

  // Point 5: a resend to the owner-set signer sends a mail.
  const resendFixed = await redistribute(page, seeded.teamId, envelopeId, [fixed.id]);
  expect(resendFixed.status()).toBe(200);

  await expect
    .poll(async () => (await mailSubjectsTo(seeded.laterEmail)).length, { timeout: 45_000 })
    .toBeGreaterThan(before);

  // Point 5: a resend to the unverified address is refused with a clear message.
  const resendTyped = await redistribute(page, seeded.teamId, envelopeId, [recipientId]);
  expect(resendTyped.status()).toBe(400);
  expect(await resendTyped.text()).toContain('is not verified');

  await sleep(2_000);
  expect(await mailSubjectsTo(typed)).toEqual([]);
});

test('[AUD-C4 follow-up]: a fixed copy recipient gets the signed copy; the anonymous visitor does not', async () => {
  requireMailSink();
  const seeded = await seedPlainDirectTemplate('CC');
  const typed = uniqueEmail('visitor');

  await submit(seeded, { email: typed });

  // Points 3 and 4: the owner-set copy recipient and the owner get "Signing Complete!".
  expect(await waitForMail(seeded.laterEmail, /^Signing Complete!$/, 90_000)).toBe(true);
  expect(await waitForMail(seeded.owner.email, /^Signing Complete!$/)).toBe(true);

  // Point 1: no signed copy to the typed address.
  await sleep(3_000);
  expect(await mailSubjectsTo(typed)).toEqual([]);
});

test('[AUD-C4 follow-up]: a visitor signed in with the typed email still gets the signed copy', async () => {
  requireMailSink();
  const seeded = await seedPlainDirectTemplate('CC');
  const { user: visitor } = await seedUser();

  const { recipientId } = await submit(seeded, {
    email: visitor.email,
    user: { id: visitor.id, name: visitor.name ?? undefined, email: visitor.email },
  });

  // Point 6: unchanged for a verified visitor.
  expect((await prisma.recipient.findUniqueOrThrow({ where: { id: recipientId } })).unverifiedEmailAt).toBeNull();
  expect(await waitForMail(visitor.email, /^Signing Complete!$/, 90_000)).toBe(true);
  expect(await waitForMail(seeded.laterEmail, /^Signing Complete!$/)).toBe(true);
});

/* -------------------------------------------------------------------------- */
/*            AUD-C10 follow-up: every credential change needs a step-up       */
/* -------------------------------------------------------------------------- */

const STEP_UP_TEXT = 'sign in again to change how you sign in';

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

const enableTwoFactorInProcess = async (userId: number) => {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  await setupTwoFactorAuthentication({ user });
  const withSecret = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  await enableTwoFactorAuthentication({ user: withSecret, code: await getCurrentTotpCode(userId) });
};

const signedInDevice = async (browser: Browser, email: string) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await apiSignin({ page, email });

  return { context, page, request: context.request };
};

const newestSessionOf = async (userId: number) =>
  await prisma.session.findFirstOrThrow({ where: { userId }, orderBy: { createdAt: 'desc' } });

/** Make the user's newest sign-in look like one from 11 minutes ago (a stolen, older session). */
const ageNewestSession = async (userId: number) => {
  const session = await newestSessionOf(userId);
  await prisma.session.update({ where: { id: session.id }, data: { createdAt: new Date(Date.now() - 11 * 60_000) } });

  return session;
};

const authPost = async (request: APIRequestContext, path: string, json?: unknown) =>
  await request.post(`${NEXT_PUBLIC_WEBAPP_URL()}/api/auth/${path}`, {
    headers: { ...WEBAPP_ORIGIN_HEADERS, 'content-type': 'application/json' },
    data: json === undefined ? undefined : JSON.stringify(json),
  });

const trpcPost = async (request: APIRequestContext, path: string, json: unknown) =>
  await request.post(`${NEXT_PUBLIC_WEBAPP_URL()}/api/trpc/${path}`, {
    headers: { ...WEBAPP_ORIGIN_HEADERS, 'content-type': 'application/json' },
    data: JSON.stringify({ json }),
  });

const seedPasskey = async (userId: number, label: string) =>
  await prisma.passkey.create({
    data: {
      userId,
      name: label,
      credentialId: Buffer.from(`audit-e-${label}-${Date.now()}`),
      credentialPublicKey: Buffer.from('audit-e-key'),
      counter: 0,
      credentialDeviceType: 'singleDevice',
      credentialBackedUp: false,
      transports: [],
    },
  });

test.describe('AUD-C10 follow-up', () => {
  test('an older session cannot turn 2FA on, and the real user stays signed in', async ({ browser }) => {
    const { user } = await seedUser();
    const victim = await signedInDevice(browser, user.email);
    const victimSession = await newestSessionOf(user.id);
    const attacker = await signedInDevice(browser, user.email);
    await ageNewestSession(user.id);

    for (const path of ['two-factor/setup', 'email-password/2fa/setup']) {
      const setup = await authPost(attacker.request, path);
      expect(setup.status(), path).toBe(401);
      expect(await setup.text()).toContain(STEP_UP_TEXT);
    }

    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).twoFactorSecret).toBeNull();

    // Even with a secret in place and a valid code, enable is refused for the older session.
    await setupTwoFactorAuthentication({ user });
    const code = await getCurrentTotpCode(user.id);

    for (const path of ['two-factor/enable', 'email-password/2fa/enable']) {
      const enable = await authPost(attacker.request, path, { code });
      expect(enable.status(), path).toBe(401);
      expect(await enable.text()).toContain(STEP_UP_TEXT);
    }

    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).twoFactorEnabled).toBe(false);
    expect(await prisma.session.findUnique({ where: { id: victimSession.id } })).not.toBeNull();

    await victim.context.close();
    await attacker.context.close();
  });

  test('an older session cannot turn 2FA off or see the backup codes, even with a code', async ({ browser }) => {
    const { user } = await seedUser();
    const device = await signedInDevice(browser, user.email);
    await ageNewestSession(user.id);
    await enableTwoFactorInProcess(user.id);

    const view = await authPost(device.request, 'two-factor/view-recovery-codes', {
      token: await getCurrentTotpCode(user.id),
    });
    expect(view.status()).toBe(401);
    expect(await view.text()).toContain(STEP_UP_TEXT);

    for (const path of ['two-factor/disable', 'email-password/2fa/disable']) {
      const disable = await authPost(device.request, path, { totpCode: await getCurrentTotpCode(user.id) });
      expect(disable.status(), path).toBe(401);
    }

    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).twoFactorEnabled).toBe(true);

    await device.context.close();
  });

  test('an older session cannot change the password', async ({ browser }) => {
    const { user } = await seedUser();
    const device = await signedInDevice(browser, user.email);
    await ageNewestSession(user.id);
    const before = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).password;

    const update = await authPost(device.request, 'email-password/update-password', {
      currentPassword: 'password',
      password: 'New_Password_123!',
    });
    expect(update.status()).toBe(401);
    expect(await update.text()).toContain(STEP_UP_TEXT);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).password).toBe(before);

    await device.context.close();
  });

  test('renaming or deleting a passkey needs a recent sign-in, and the 2FA code when 2FA is on', async ({
    browser,
  }) => {
    const { user } = await seedUser();
    const passkey = await seedPasskey(user.id, 'Old key');
    const device = await signedInDevice(browser, user.email);
    const session = await ageNewestSession(user.id);

    const staleRename = await trpcPost(device.request, 'auth.passkey.update', {
      passkeyId: passkey.id,
      name: 'Renamed',
    });
    expect(staleRename.status()).toBe(401);
    expect(await staleRename.text()).toContain(STEP_UP_TEXT);

    const staleDelete = await trpcPost(device.request, 'auth.passkey.delete', { passkeyId: passkey.id });
    expect(staleDelete.status()).toBe(401);
    expect(await prisma.passkey.findUnique({ where: { id: passkey.id } })).not.toBeNull();

    // Fresh again, but 2FA is on: the code is needed.
    await prisma.session.update({ where: { id: session.id }, data: { createdAt: new Date() } });
    await enableTwoFactorInProcess(user.id);

    const noCode = await trpcPost(device.request, 'auth.passkey.delete', { passkeyId: passkey.id });
    expect(noCode.status()).toBe(400);
    expect(await noCode.text()).toContain('authenticator app to make this change');

    const rename = await trpcPost(device.request, 'auth.passkey.update', {
      passkeyId: passkey.id,
      name: 'Renamed',
      twoFactorCode: await getCurrentTotpCode(user.id),
    });
    expect(rename.ok(), await rename.text()).toBe(true);
    expect((await prisma.passkey.findUniqueOrThrow({ where: { id: passkey.id } })).name).toBe('Renamed');

    await device.context.close();
  });

  test('the Enable 2FA dialog says to sign in again', async ({ browser }) => {
    const { user } = await seedUser();
    const device = await signedInDevice(browser, user.email);
    await ageNewestSession(user.id);

    await device.page.goto(`${NEXT_PUBLIC_WEBAPP_URL()}/settings/security`);
    await device.page.getByRole('button', { name: 'Enable 2FA' }).click();

    await expect(device.page.getByText(/sign in again to change how you sign in/).first()).toBeVisible();

    await device.context.close();
  });
});

/* -------------------------------------------------------------------------- */
/*   AUD-C11 follow-up: on an action-auth document, the recipient's own session  */
/* -------------------------------------------------------------------------- */

const seedActionAuthDocument = async (options: {
  actionAuth: string[];
  internalVersion?: number;
  recipientActionAuth?: string[];
  fieldsSigned?: boolean;
}) => {
  const { user: owner, team } = await seedUser();
  const { user: signerUser } = await seedUser();

  const { document, recipients } = await seedPendingDocumentWithFullFields({
    owner,
    teamId: team.id,
    recipients: [signerUser],
    fields: [FieldType.SIGNATURE],
    updateDocumentOptions: {
      internalVersion: options.internalVersion ?? 2,
      authOptions: { globalAccessAuth: [], globalActionAuth: options.actionAuth },
    },
  });

  const [recipient] = recipients;

  if (options.recipientActionAuth) {
    await prisma.recipient.update({
      where: { id: recipient.id },
      data: { authOptions: { accessAuth: [], actionAuth: options.recipientActionAuth } },
    });
  }

  // The recipient signed every field themselves.
  const field = await prisma.field.findFirstOrThrow({ where: { recipientId: recipient.id } });

  if (options.fieldsSigned !== false) {
    await prisma.field.update({ where: { id: field.id }, data: { inserted: true } });
    await prisma.signature.create({ data: { fieldId: field.id, recipientId: recipient.id, typedSignature: 'Signer' } });
  }

  return {
    document,
    documentId: mapSecondaryIdToDocumentId(document.secondaryId),
    recipient,
    field,
    signerUser,
  };
};

const recipientStatus = async (recipientId: number) =>
  (await prisma.recipient.findUniqueOrThrow({ where: { id: recipientId } })).signingStatus;

test.describe('AUD-C11 follow-up', () => {
  test('a signed-out holder of the link cannot complete an action-auth document', async ({ request }) => {
    for (const actionAuth of ['PASSWORD', 'ACCOUNT', 'PASSKEY', 'TWO_FACTOR_AUTH']) {
      const seeded = await seedActionAuthDocument({ actionAuth: [actionAuth] });

      const complete = await trpcPost(request, 'recipient.completeDocumentWithToken', {
        token: seeded.recipient.token,
        documentId: seeded.documentId,
      });
      expect(complete.status(), actionAuth).toBe(401);
      expect(await complete.text()).toContain('Sign in as the recipient');
      expect(await recipientStatus(seeded.recipient.id)).toBe(SigningStatus.NOT_SIGNED);
    }
  });

  test('a signed-out holder of the link cannot un-sign the recipient fields', async ({ request }) => {
    const v2 = await seedActionAuthDocument({ actionAuth: ['PASSWORD'] });

    const unsign = await trpcPost(request, 'envelope.field.sign', {
      token: v2.recipient.token,
      fieldId: v2.field.id,
      fieldValue: { type: FieldType.SIGNATURE, value: null },
    });
    expect(unsign.status()).toBe(401);
    expect((await prisma.field.findUniqueOrThrow({ where: { id: v2.field.id } })).inserted).toBe(true);

    const v1 = await seedActionAuthDocument({ actionAuth: ['PASSWORD'], internalVersion: 1 });

    const remove = await trpcPost(request, 'field.removeSignedFieldWithToken', {
      token: v1.recipient.token,
      fieldId: v1.field.id,
    });
    expect(remove.status()).toBe(401);
    expect((await prisma.field.findUniqueOrThrow({ where: { id: v1.field.id } })).inserted).toBe(true);
  });

  test('a signed-out holder of the link cannot decline an action-auth document', async ({ request }) => {
    const seeded = await seedActionAuthDocument({ actionAuth: ['PASSWORD'], fieldsSigned: false });

    const reject = await trpcPost(request, 'recipient.rejectDocumentWithToken', {
      token: seeded.recipient.token,
      documentId: seeded.documentId,
      reason: 'Not me',
    });
    expect(reject.status()).toBe(401);
    expect(await recipientStatus(seeded.recipient.id)).toBe(SigningStatus.NOT_SIGNED);
  });

  test('the recipient signed in with their own account still completes and declines', async ({ browser }) => {
    const toComplete = await seedActionAuthDocument({ actionAuth: ['PASSWORD'] });
    const asRecipient = await signedInDevice(browser, toComplete.signerUser.email);

    const complete = await trpcPost(asRecipient.request, 'recipient.completeDocumentWithToken', {
      token: toComplete.recipient.token,
      documentId: toComplete.documentId,
    });
    expect(complete.ok(), await complete.text()).toBe(true);
    expect(await recipientStatus(toComplete.recipient.id)).toBe(SigningStatus.SIGNED);
    await asRecipient.context.close();

    const toDecline = await seedActionAuthDocument({ actionAuth: ['ACCOUNT'], fieldsSigned: false });
    const decliner = await signedInDevice(browser, toDecline.signerUser.email);

    const reject = await trpcPost(decliner.request, 'recipient.rejectDocumentWithToken', {
      token: toDecline.recipient.token,
      documentId: toDecline.documentId,
      reason: 'Wrong terms',
    });
    expect(reject.ok(), await reject.text()).toBe(true);
    expect(await recipientStatus(toDecline.recipient.id)).toBe(SigningStatus.REJECTED);
    await decliner.context.close();
  });

  test('without action auth, or with EXPLICIT_NONE, signed-out completion is unchanged', async ({ request }) => {
    for (const seeded of [
      await seedActionAuthDocument({ actionAuth: [] }),
      await seedActionAuthDocument({ actionAuth: ['PASSWORD'], recipientActionAuth: ['EXPLICIT_NONE'] }),
    ]) {
      const complete = await trpcPost(request, 'recipient.completeDocumentWithToken', {
        token: seeded.recipient.token,
        documentId: seeded.documentId,
      });
      expect(complete.ok(), await complete.text()).toBe(true);
      expect(await recipientStatus(seeded.recipient.id)).toBe(SigningStatus.SIGNED);
    }
  });
});
