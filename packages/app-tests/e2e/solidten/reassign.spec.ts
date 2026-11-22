import fs from 'node:fs';
import path from 'node:path';
import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { completeDocumentWithToken } from '@documenso/lib/server-only/document/complete-document-with-token';
import { createApiToken } from '@documenso/lib/server-only/public-api/create-api-token';
import { prisma } from '@documenso/prisma';
import { DocumentStatus, EnvelopeType, RecipientRole } from '@documenso/prisma/client';
import { seedPendingDocument } from '@documenso/prisma/seed/documents';
import { seedTeamMember } from '@documenso/prisma/seed/teams';
import { seedUser } from '@documenso/prisma/seed/users';
import type {
  TCreateEnvelopePayload,
  TCreateEnvelopeResponse,
} from '@documenso/trpc/server/envelope-router/create-envelope.types';
import type { APIRequestContext } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { apiSignin, WEBAPP_ORIGIN_HEADERS } from '../fixtures/authentication';
import { expectToastTextToBeVisible } from '../fixtures/generic';
import { expectHandedOverLink } from '../fixtures/signing-links';

const webappUrl = NEXT_PUBLIC_WEBAPP_URL();
const baseUrl = `${webappUrl}/api/v2-beta`;

const examplePdf = fs.readFileSync(path.join(__dirname, '../../../../assets/example.pdf'));

test.describe.configure({ mode: 'parallel' });

const uniqueEmail = (label: string) =>
  `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.documenso.com`;

const signatureField = {
  type: 'SIGNATURE' as const,
  page: 1,
  positionX: 10,
  positionY: 10,
  width: 10,
  height: 5,
  fieldMeta: { type: 'signature' as const },
};

const textField = {
  type: 'TEXT' as const,
  page: 1,
  positionX: 30,
  positionY: 10,
  width: 10,
  height: 5,
  fieldMeta: { type: 'text' as const },
};

type CreatePendingOptions = {
  signerCount?: number;
  sequential?: boolean;
  signingOrders?: number[];
};

const createPendingViaApi = async (request: APIRequestContext, options: CreatePendingOptions = {}) => {
  const { signerCount = 1, sequential = false, signingOrders } = options;

  const { user, team, organisation } = await seedUser();

  const { token } = await createApiToken({
    userId: user.id,
    teamId: team.id,
    tokenName: 'reassign',
    expiresIn: null,
  });

  const payload: TCreateEnvelopePayload = {
    type: EnvelopeType.DOCUMENT,
    title: '[TEST] Reassign',
    meta: sequential ? { signingOrder: 'SEQUENTIAL' } : undefined,
    recipients: Array.from({ length: signerCount }, (_, index) => ({
      email: uniqueEmail(`signer${index + 1}`),
      name: `Signer ${index + 1}`,
      role: RecipientRole.SIGNER,
      signingOrder: signingOrders?.[index] ?? index + 1,
      fields: [signatureField, textField],
    })),
  };

  const formData = new FormData();
  formData.append('payload', JSON.stringify(payload));
  formData.append('files', new File([examplePdf], 'example.pdf', { type: 'application/pdf' }));

  const authHeaders = { Authorization: `Bearer ${token}` };

  const createRes = await request.post(`${baseUrl}/envelope/create`, { headers: authHeaders, multipart: formData });
  expect(createRes.ok()).toBeTruthy();

  const { id: envelopeId }: TCreateEnvelopeResponse = await createRes.json();

  const distributeRes = await request.post(`${baseUrl}/envelope/distribute`, {
    headers: authHeaders,
    data: { envelopeId },
  });
  expect(distributeRes.ok()).toBeTruthy();

  const recipients = await prisma.recipient.findMany({
    where: { envelopeId },
    orderBy: { id: 'asc' },
    include: { fields: true },
  });

  const senderReassign = async (recipientId: number, data: { name: string; email: string; reason?: string }) =>
    await request.post(`${baseUrl}/envelope/recipient/reassign`, {
      headers: authHeaders,
      data: { envelopeId, recipientId, ...data },
    });

  return { user, team, organisation, envelopeId, recipients, authHeaders, senderReassign };
};

const allowSignerReassign = async (teamId: number) => {
  const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId } });

  await prisma.teamGlobalSettings.update({
    where: { id: team.teamGlobalSettingsId },
    data: { allowSignerReassign: true },
  });
};

/**
 * Call the public signer route the way the signing page does.
 */
const signerReassign = async (
  request: APIRequestContext,
  input: { token: string; name: string; email: string; reason?: string },
) =>
  await request.post(`${webappUrl}/api/trpc/lifecycle.reassignRecipientWithToken`, {
    headers: { Origin: new URL(webappUrl).origin },
    data: { json: input },
  });

/**
 * Optional Mailpit API (for example http://127.0.0.1:8025) receiving the app's SMTP.
 */
const MAIL_SINK_URL = process.env.E2E_MAIL_SINK_URL;

const findMailSubjects = async (to: string) => {
  const res = await fetch(`${MAIL_SINK_URL}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
  const body = (await res.json()) as { messages?: { Subject: string }[] };

  return (body.messages ?? []).map((message) => message.Subject);
};

const getJobs = async (jobId: string) =>
  await prisma.backgroundJob.findMany({ where: { jobId }, orderBy: { submittedAt: 'desc' }, take: 200 });

test('[REASSIGN]: signer reassignment is off by default and the signing page does not offer it', async ({
  page,
  request,
}) => {
  const { recipients } = await createPendingViaApi(request);
  const [recipient] = recipients;

  await page.goto(`/sign/${recipient.token}`);
  await expect(page.getByRole('button', { name: 'Reject Document' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reassign' })).toHaveCount(0);

  const res = await signerReassign(request, { token: recipient.token, name: 'Someone', email: uniqueEmail('x') });
  expect(res.ok()).toBeFalsy();

  const unchanged = await prisma.recipient.findUniqueOrThrow({ where: { id: recipient.id } });
  expect(unchanged.token).toBe(recipient.token);
});

test('[REASSIGN]: a signer hands the request on from the signing page and the old link dies', async ({
  page,
  request,
}) => {
  const { team, envelopeId, recipients } = await createPendingViaApi(request);
  const [recipient] = recipients;

  await allowSignerReassign(team.id);

  const webhook = await prisma.webhook.create({
    data: {
      webhookUrl: 'https://example.com/solidten-reassign-hook',
      eventTriggers: ['RECIPIENT_REASSIGNED'],
      userId: (await prisma.envelope.findUniqueOrThrow({ where: { id: envelopeId } })).userId,
      teamId: team.id,
    },
  });

  // The old person had started: one field filled and signed.
  const signature = recipient.fields.find((field) => field.type === 'SIGNATURE');
  const text = recipient.fields.find((field) => field.type === 'TEXT');

  if (!signature || !text) {
    throw new Error('Seeded fields are missing');
  }

  await prisma.field.update({ where: { id: text.id }, data: { inserted: true, customText: 'old person text' } });
  await prisma.field.update({ where: { id: signature.id }, data: { inserted: true, customText: '' } });
  await prisma.signature.create({
    data: { recipientId: recipient.id, fieldId: signature.id, typedSignature: 'Old Person' },
  });
  await prisma.recipient.update({ where: { id: recipient.id }, data: { readStatus: 'OPENED', reminderCount: 2 } });

  await page.goto(`/sign/${recipient.token}`);
  await page.getByRole('button', { name: 'Reassign' }).first().click();

  const newEmail = uniqueEmail('new');

  const dialog = page.getByRole('dialog');

  await dialog.getByLabel('Name').fill('New Person');
  await dialog.getByLabel('Email').fill(newEmail);
  await dialog.getByLabel(/Reason/).fill('I left the company');
  await dialog.getByRole('button', { name: 'Reassign', exact: true }).click();

  await expect(page.getByTestId('reassign-done')).toBeVisible({ timeout: 30_000 });

  const updated = await prisma.recipient.findUniqueOrThrow({
    where: { id: recipient.id },
    include: { fields: true, signatures: true },
  });

  expect(updated.token).not.toBe(recipient.token);
  expect(updated.email).toBe(newEmail);
  expect(updated.name).toBe('New Person');
  expect(updated.readStatus).toBe('NOT_OPENED');
  expect(updated.reminderCount).toBe(0);
  expect(updated.signingOrder).toBe(recipient.signingOrder);
  expect(updated.signatures).toHaveLength(0);
  expect(updated.fields.every((field) => !field.inserted && field.customText === '')).toBe(true);

  const audit = await prisma.documentAuditLog.findFirstOrThrow({
    where: { envelopeId, type: 'RECIPIENT_REASSIGNED' },
  });

  expect(audit.email).toBe(recipient.email);
  expect(audit.userAgent).toBeTruthy();
  expect(audit.data).toMatchObject({
    recipientId: recipient.id,
    fromEmail: recipient.email,
    toEmail: newEmail,
    toName: 'New Person',
    reason: 'I left the company',
    reassignedBy: 'SIGNER',
  });
  expect((audit.data as { clearedFieldIds: number[] }).clearedFieldIds.sort()).toEqual([signature.id, text.id].sort());

  await expectHandedOverLink(page, recipient.token);

  const newLink = await page.goto(`/sign/${updated.token}`);
  expect(newLink?.status()).toBe(200);

  const signingEmails = await getJobs('send.signing.requested.email');
  expect(
    signingEmails.some((job) => (job.payload as { recipientId?: number }).recipientId === recipient.id),
  ).toBeTruthy();

  const notices = await getJobs('send.solidten.notice.email');
  expect(
    notices.some(
      (job) =>
        (job.payload as { kind?: string; oldEmail?: string }).kind === 'RECIPIENT_REASSIGNED' &&
        (job.payload as { oldEmail?: string }).oldEmail === recipient.email,
    ),
  ).toBeTruthy();

  const webhookJobs = await getJobs('internal.execute-webhook');
  expect(
    webhookJobs.some(
      (job) =>
        (job.payload as { webhookId?: string; event?: string }).webhookId === webhook.id &&
        (job.payload as { event?: string }).event === 'RECIPIENT_REASSIGNED',
    ),
  ).toBeTruthy();
});

test('[REASSIGN]: a signer whose page is still open cannot act after the sender reassigns', async ({
  page,
  request,
}) => {
  const { envelopeId, recipients, senderReassign } = await createPendingViaApi(request);
  const [recipient] = recipients;

  await page.goto(`/sign/${recipient.token}`);
  await expect(page.getByRole('button', { name: 'Reject Document' })).toBeVisible();

  const res = await senderReassign(recipient.id, { name: 'Replacement', email: uniqueEmail('replacement') });
  expect(res.ok()).toBeTruthy();

  // The open page's next call carries the old token and fails. The page may already
  // have moved on its own (it also checks when the tab regains focus).
  try {
    await page.getByRole('button', { name: 'Reject Document' }).click({ timeout: 2_000 });
    await page.getByRole('dialog').getByRole('textbox').fill('too late', { timeout: 2_000 });
    await page.getByRole('dialog').getByRole('button', { name: 'Reject Document' }).click({ timeout: 2_000 });
  } catch {
    // Already redirected.
  }

  // The open page notices that its link was handed over and explains it.
  await expect(page).toHaveURL(new RegExp(`/sign/${recipient.token}/reassigned$`), { timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'This request was passed to someone else' })).toBeVisible();

  await expect(
    completeDocumentWithToken({
      token: recipient.token,
      id: { type: 'envelopeId', id: envelopeId },
      requestMetadata: {},
    }),
  ).rejects.toThrow();

  const updated = await prisma.recipient.findUniqueOrThrow({ where: { id: recipient.id } });
  expect(updated.signingStatus).toBe('NOT_SIGNED');

  const audit = await prisma.documentAuditLog.findFirstOrThrow({ where: { envelopeId, type: 'RECIPIENT_REASSIGNED' } });
  expect((audit.data as { reassignedBy: string }).reassignedBy).toBe('SENDER');
  // An API token acts as its team, so the audit row names the team.
  expect(audit.name).toBeTruthy();
});

test('[REASSIGN]: the sender reassigns from the document page', async ({ page, request }) => {
  const { user, team, envelopeId, recipients } = await createPendingViaApi(request);
  const [recipient] = recipients;

  await apiSignin({ page, email: user.email, redirectPath: `/t/${team.url}/documents/${envelopeId}` });

  await page.getByTestId(`reassign-recipient-${recipient.id}`).click();

  const newEmail = uniqueEmail('from-ui');

  const dialog = page.getByRole('dialog');

  await dialog.getByLabel('Name').fill('UI Person');
  await dialog.getByLabel('Email').fill(newEmail);
  await dialog.getByRole('button', { name: 'Reassign', exact: true }).click();

  await expectToastTextToBeVisible(page, 'Recipient reassigned');
  await expect(page.getByText(newEmail).first()).toBeVisible();

  const audit = await prisma.documentAuditLog.findFirstOrThrow({ where: { envelopeId, type: 'RECIPIENT_REASSIGNED' } });
  expect(audit.userId).toBe(user.id);
  expect(audit.data).toMatchObject({ reassignedBy: 'SENDER', toEmail: newEmail, reason: null });
});

test('[REASSIGN]: refuses an email already on the document, a signed recipient, and a finished document', async ({
  request,
}) => {
  const { envelopeId, recipients, senderReassign } = await createPendingViaApi(request, { signerCount: 2 });
  const [first, second] = recipients;

  const toOther = await senderReassign(first.id, { name: 'Dup', email: second.email.toUpperCase() });
  expect(toOther.ok()).toBeFalsy();

  const toSelf = await senderReassign(first.id, { name: 'Same', email: first.email });
  expect(toSelf.ok()).toBeFalsy();

  await prisma.recipient.update({ where: { id: second.id }, data: { signingStatus: 'SIGNED', signedAt: new Date() } });

  const signed = await senderReassign(second.id, { name: 'Late', email: uniqueEmail('late') });
  expect(signed.ok()).toBeFalsy();

  await prisma.envelope.update({ where: { id: envelopeId }, data: { status: DocumentStatus.COMPLETED } });

  const completed = await senderReassign(first.id, { name: 'Late', email: uniqueEmail('late') });
  expect(completed.ok()).toBeFalsy();

  const unchanged = await prisma.recipient.findMany({ where: { envelopeId }, orderBy: { id: 'asc' } });
  expect(unchanged.map((recipient) => recipient.token)).toEqual([first.token, second.token]);
  expect(await prisma.documentAuditLog.count({ where: { envelopeId, type: 'RECIPIENT_REASSIGNED' } })).toBe(0);
});

test('[REASSIGN]: refuses qualified-signature and version-1 envelopes', async ({ request }) => {
  const tsp = await createPendingViaApi(request);

  await prisma.envelope.update({ where: { id: tsp.envelopeId }, data: { signatureLevel: 'QES' } });

  const tspRes = await tsp.senderReassign(tsp.recipients[0].id, { name: 'X', email: uniqueEmail('tsp') });
  expect(tspRes.ok()).toBeFalsy();

  const { user, team } = await seedUser();
  const legacy = await seedPendingDocument(user, team.id, [uniqueEmail('legacy')]);

  const { token } = await createApiToken({ userId: user.id, teamId: team.id, tokenName: 'legacy', expiresIn: null });

  const legacyRes = await request.post(`${baseUrl}/envelope/recipient/reassign`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      envelopeId: legacy.id,
      recipientId: legacy.recipients[0].id,
      name: 'X',
      email: uniqueEmail('legacy-new'),
    },
  });

  expect(legacyRes.ok()).toBeFalsy();
  expect(await legacyRes.text()).toContain('current editor');
});

test('[REASSIGN]: in a sequential order a later signer is reassigned without being emailed early', async ({
  request,
}) => {
  const { recipients, senderReassign } = await createPendingViaApi(request, { signerCount: 2, sequential: true });
  const [first, second] = recipients;

  const res = await senderReassign(second.id, { name: 'Later Person', email: uniqueEmail('later') });
  expect(res.ok()).toBeTruthy();

  const updated = await prisma.recipient.findUniqueOrThrow({ where: { id: second.id } });
  expect(updated.token).not.toBe(second.token);
  expect(updated.signingOrder).toBe(2);

  const signingEmails = await getJobs('send.signing.requested.email');
  expect(signingEmails.some((job) => (job.payload as { recipientId?: number }).recipientId === second.id)).toBe(false);

  const firstAfter = await prisma.recipient.findUniqueOrThrow({ where: { id: first.id } });
  expect(firstAfter.token).toBe(first.token);
});

test('[REASSIGN]: in a grouped step only the reassigned member changes', async ({ request }) => {
  const { recipients, senderReassign } = await createPendingViaApi(request, {
    signerCount: 2,
    sequential: true,
    signingOrders: [1, 1],
  });
  const [first, second] = recipients;

  expect(first.signingOrder).toBe(second.signingOrder);

  const res = await senderReassign(first.id, { name: 'Group Swap', email: uniqueEmail('group') });
  expect(res.ok()).toBeTruthy();

  const [firstAfter, secondAfter] = await prisma.recipient.findMany({
    where: { id: { in: [first.id, second.id] } },
    orderBy: { id: 'asc' },
  });

  expect(firstAfter.token).not.toBe(first.token);
  expect(firstAfter.expiresAt?.getTime() ?? 0).toBeGreaterThan(first.expiresAt?.getTime() ?? 0);
  expect(secondAfter.token).toBe(second.token);
  expect(secondAfter.email).toBe(second.email);

  // Both members of the active step are asked to act, so the new person is emailed now.
  const signingEmails = await getJobs('send.signing.requested.email');
  expect(signingEmails.some((job) => (job.payload as { recipientId?: number }).recipientId === first.id)).toBe(true);
});

test('[REASSIGN]: a signer behind an account check must be signed in; behind 2FA only the sender can reassign', async ({
  request,
}) => {
  const account = await createPendingViaApi(request);
  await allowSignerReassign(account.team.id);

  await prisma.recipient.update({
    where: { id: account.recipients[0].id },
    data: { authOptions: { accessAuth: ['ACCOUNT'], actionAuth: [] } },
  });

  const anonymous = await signerReassign(request, {
    token: account.recipients[0].token,
    name: 'X',
    email: uniqueEmail('acct'),
  });
  expect(anonymous.ok()).toBeFalsy();
  expect(await anonymous.text()).toContain('Sign in');

  const twoFactor = await createPendingViaApi(request);
  await allowSignerReassign(twoFactor.team.id);

  await prisma.recipient.update({
    where: { id: twoFactor.recipients[0].id },
    data: { authOptions: { accessAuth: ['TWO_FACTOR_AUTH'], actionAuth: [] } },
  });

  const bySigner = await signerReassign(request, {
    token: twoFactor.recipients[0].token,
    name: 'X',
    email: uniqueEmail('2fa'),
  });
  expect(bySigner.ok()).toBeFalsy();

  const bySender = await twoFactor.senderReassign(twoFactor.recipients[0].id, {
    name: 'Verified Elsewhere',
    email: uniqueEmail('2fa-sender'),
  });
  expect(bySender.ok()).toBeTruthy();

  const updated = await prisma.recipient.findUniqueOrThrow({ where: { id: twoFactor.recipients[0].id } });
  expect(updated.authOptions).toMatchObject({ accessAuth: ['TWO_FACTOR_AUTH'] });
});

test('[REASSIGN]: team managers can turn signer reassignment on in settings', async ({ page }) => {
  const { user, team } = await seedUser();

  await apiSignin({ page, email: user.email, redirectPath: `/t/${team.url}/settings/lifecycle` });

  await expect(page.getByRole('heading', { name: 'Document lifecycle' })).toBeVisible();
  await page.getByTestId('allow-signer-reassign-select').click();
  await page.getByRole('option', { name: 'Allowed', exact: true }).click();
  await page.getByTestId('reassign-settings').getByRole('button', { name: /Save/ }).click();

  await expectToastTextToBeVisible(page, 'Reassignment settings updated');

  const settings = await prisma.teamGlobalSettings.findFirstOrThrow({ where: { team: { id: team.id } } });
  expect(settings.allowSignerReassign).toBe(true);
  expect(settings.allowSenderReassign).toBeNull();
});

test('[REASSIGN]: a sender changing a sent recipient email through the API is a reassignment', async ({
  page,
  request,
}) => {
  const { envelopeId, recipients, authHeaders } = await createPendingViaApi(request);
  const [recipient] = recipients;

  await prisma.recipient.update({ where: { id: recipient.id }, data: { readStatus: 'OPENED', reminderCount: 2 } });

  const newEmail = uniqueEmail('changed');

  const res = await request.post(`${baseUrl}/envelope/recipient/update-many`, {
    headers: authHeaders,
    data: { envelopeId, data: [{ id: recipient.id, email: newEmail }] },
  });
  expect(res.ok(), await res.text()).toBeTruthy();

  const updated = await prisma.recipient.findUniqueOrThrow({ where: { id: recipient.id } });

  expect(updated.email).toBe(newEmail);
  expect(updated.token).not.toBe(recipient.token);
  expect(updated.readStatus).toBe('NOT_OPENED');
  expect(updated.reminderCount).toBe(0);
  expect(updated.expiresAt?.getTime() ?? 0).toBeGreaterThan(recipient.expiresAt?.getTime() ?? 0);

  // The link already emailed to the old address must no longer open the document.
  await expectHandedOverLink(page, recipient.token);

  const audit = await prisma.documentAuditLog.findFirstOrThrow({ where: { envelopeId, type: 'RECIPIENT_REASSIGNED' } });
  expect(audit.data).toMatchObject({ fromEmail: recipient.email, toEmail: newEmail, reassignedBy: 'SENDER' });

  // A normal signing request goes to the new address, not a reminder.
  const signingEmails = await getJobs('send.signing.requested.email');
  expect(signingEmails.some((job) => (job.payload as { recipientId?: number }).recipientId === recipient.id)).toBe(
    true,
  );

  // When a mail sink is configured, check the message that was actually sent.
  if (MAIL_SINK_URL) {
    await expect
      .poll(async () => (await findMailSubjects(newEmail)).join(' | '), { timeout: 60_000 })
      .toMatch(/please sign|invited you to sign/i);

    expect((await findMailSubjects(newEmail)).some((subject) => /reminder/i.test(subject))).toBe(false);
  }

  const notices = await getJobs('send.solidten.notice.email');
  expect(notices.some((job) => (job.payload as { oldEmail?: string }).oldEmail === recipient.email)).toBe(true);
});

test('[REASSIGN]: the editor path treats an email change as a reassignment and a name change as an edit', async ({
  page,
  request,
}) => {
  const { user, team, envelopeId, recipients } = await createPendingViaApi(request, { signerCount: 2 });
  const [first, second] = recipients;

  await apiSignin({ page, email: user.email, redirectPath: `/t/${team.url}/documents/${envelopeId}` });

  const newEmail = uniqueEmail('editor');

  // The route the editor's recipient step saves through (setDocumentRecipients).
  const res = await page.context().request.post(`${webappUrl}/api/trpc/envelope.recipient.set`, {
    headers: { ...WEBAPP_ORIGIN_HEADERS, 'x-team-id': String(team.id) },
    data: {
      json: {
        envelopeId,
        envelopeType: 'DOCUMENT',
        recipients: [
          { id: first.id, email: newEmail, name: first.name, role: first.role, signingOrder: first.signingOrder },
          { id: second.id, email: second.email, name: 'Renamed', role: second.role, signingOrder: second.signingOrder },
        ],
      },
    },
  });
  expect(res.ok(), await res.text()).toBeTruthy();

  const [firstAfter, secondAfter] = await prisma.recipient.findMany({
    where: { id: { in: [first.id, second.id] } },
    orderBy: { id: 'asc' },
  });

  expect(firstAfter.email).toBe(newEmail);
  expect(firstAfter.token).not.toBe(first.token);
  await expectHandedOverLink(page, first.token);

  expect(secondAfter.name).toBe('Renamed');
  expect(secondAfter.token).toBe(second.token);

  const reassigned = await prisma.documentAuditLog.findMany({ where: { envelopeId, type: 'RECIPIENT_REASSIGNED' } });
  expect(reassigned).toHaveLength(1);
  expect(reassigned[0].data).toMatchObject({ recipientId: first.id, toEmail: newEmail, reassignedBy: 'SENDER' });
});

test('[REASSIGN][S-L5]: the owner is emailed on a self-reassignment, and names lose control characters', async ({
  request,
}) => {
  const { user, team, envelopeId, recipients } = await createPendingViaApi(request);
  await allowSignerReassign(team.id);

  const [signer] = recipients;
  const newEmail = uniqueEmail('handed-to');

  const response = await signerReassign(request, {
    token: signer.token,
    name: 'Orig‮LIAM\nSigned by CEO',
    email: newEmail,
    reason: 'Out⁦ of office\u0007',
  });
  expect(response.ok(), await response.text()).toBe(true);

  const updated = await prisma.recipient.findUniqueOrThrow({ where: { id: signer.id } });
  expect(updated.name).toBe('OrigLIAM Signed by CEO');

  const audit = await prisma.documentAuditLog.findFirstOrThrow({
    where: { envelopeId, type: 'RECIPIENT_REASSIGNED' },
  });
  expect(audit.data).toMatchObject({ toName: 'OrigLIAM Signed by CEO', reason: 'Out of office' });

  // The owner gets a notice.
  await expect
    .poll(
      async () =>
        await prisma.backgroundJob.count({
          where: {
            jobId: 'send.solidten.notice.email',
            payload: { path: ['kind'], equals: 'RECIPIENT_SELF_REASSIGNED' },
            AND: [{ payload: { path: ['envelopeId'], equals: envelopeId } }],
          },
        }),
      { timeout: 20_000 },
    )
    .toBe(1);

  if (MAIL_SINK_URL) {
    await expect
      .poll(async () => await findMailSubjects(user.email), { timeout: 20_000 })
      .toContain('A signer passed "[TEST] Reassign" to someone else');
  }
});

test('[REASSIGN][SEC2-L2]: a reassigned name loses zero-width characters, from the signer and the sender', async ({
  request,
}) => {
  const { team, envelopeId, recipients, authHeaders } = await createPendingViaApi(request, { signerCount: 2 });
  await allowSignerReassign(team.id);

  const [bySigner, bySender] = recipients;

  const signer = await signerReassign(request, {
    token: bySigner.token,
    name: 'Pat\u200BLee\u2060',
    email: uniqueEmail('zw-signer'),
    reason: 'On\uFEFF leave',
  });
  expect(signer.ok(), await signer.text()).toBe(true);

  const sender = await request.post(`${baseUrl}/envelope/recipient/reassign`, {
    headers: authHeaders,
    data: { envelopeId, recipientId: bySender.id, name: '\u200DSam\u200C Ray', email: uniqueEmail('zw-sender') },
  });
  expect(sender.ok(), await sender.text()).toBe(true);

  expect((await prisma.recipient.findUniqueOrThrow({ where: { id: bySigner.id } })).name).toBe('PatLee');
  expect((await prisma.recipient.findUniqueOrThrow({ where: { id: bySender.id } })).name).toBe('Sam Ray');

  const audits = await prisma.documentAuditLog.findMany({ where: { envelopeId, type: 'RECIPIENT_REASSIGNED' } });
  expect(JSON.stringify(audits.map((audit) => audit.data))).not.toMatch(/[\u200B-\u200D\u2060\uFEFF]/);
});

/** The full text of every message the mail sink holds for an address. */
const findMailTexts = async (to: string) => {
  const res = await fetch(`${MAIL_SINK_URL}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
  const body = (await res.json()) as { messages?: { ID: string }[] };

  return await Promise.all(
    (body.messages ?? []).map(async ({ ID }) => {
      const message = (await (await fetch(`${MAIL_SINK_URL}/api/v1/message/${ID}`)).json()) as {
        Subject: string;
        Text: string;
        HTML: string;
      };

      return `${message.Subject}\n${message.Text}\n${message.HTML}`;
    }),
  );
};

const findReassignNotice = async (oldEmail: string) => {
  const notices = await getJobs('send.solidten.notice.email');

  return notices.find((job) => {
    const payload = job.payload as { kind?: string; oldEmail?: string };

    return payload.kind === 'RECIPIENT_REASSIGNED' && payload.oldEmail === oldEmail;
  });
};

test('[REASSIGN][SEC2-M2]: a sender correction never tells the old address who has the request now', async ({
  request,
}) => {
  test.setTimeout(120_000);

  const { envelopeId, recipients, authHeaders } = await createPendingViaApi(request, { signerCount: 2 });
  const [byEmailEdit, byReassign] = recipients;

  // 1. The sender corrects a wrong address (update-many). Without a name the notice used to show
  //    the new address itself.
  await prisma.recipient.update({ where: { id: byEmailEdit.id }, data: { name: '' } });

  const correctedEmail = uniqueEmail('right-person');
  const edit = await request.post(`${baseUrl}/envelope/recipient/update-many`, {
    headers: authHeaders,
    data: { envelopeId, data: [{ id: byEmailEdit.id, email: correctedEmail }] },
  });
  expect(edit.ok(), await edit.text()).toBeTruthy();

  // 2. The sender reassigns to a named person.
  const reassignedEmail = uniqueEmail('new-person');
  const reassign = await request.post(`${baseUrl}/envelope/recipient/reassign`, {
    headers: authHeaders,
    data: { envelopeId, recipientId: byReassign.id, name: 'Right Person', email: reassignedEmail },
  });
  expect(reassign.ok(), await reassign.text()).toBeTruthy();

  for (const [old, newEmail] of [
    [byEmailEdit, correctedEmail],
    [byReassign, reassignedEmail],
  ] as const) {
    await expect.poll(async () => Boolean(await findReassignNotice(old.email))).toBe(true);

    const payload = JSON.stringify((await findReassignNotice(old.email))?.payload);
    expect(payload).not.toContain(newEmail);
    expect(payload).not.toContain('Right Person');

    if (MAIL_SINK_URL) {
      await expect
        .poll(async () => (await findMailTexts(old.email)).join('\n'), { timeout: 60_000 })
        .toMatch(/passed to someone else/);

      const texts = (await findMailTexts(old.email)).join('\n');
      expect(texts).not.toContain(newEmail);
      expect(texts).not.toContain('Right Person');
    }
  }
});

test('[REASSIGN][RT2-L1]: a new recipient cannot take an email already on a sent document', async ({ request }) => {
  const { envelopeId, recipients, authHeaders } = await createPendingViaApi(request);

  const duplicate = await request.post(`${baseUrl}/envelope/recipient/create-many`, {
    headers: authHeaders,
    data: {
      envelopeId,
      data: [{ email: recipients[0].email.toUpperCase(), name: 'Copy', role: RecipientRole.SIGNER }],
    },
  });
  expect(duplicate.ok()).toBe(false);
  expect(await duplicate.text()).toContain('already a recipient on this document');

  const fresh = await request.post(`${baseUrl}/envelope/recipient/create-many`, {
    headers: authHeaders,
    data: { envelopeId, data: [{ email: uniqueEmail('fresh'), name: 'Fresh', role: RecipientRole.SIGNER }] },
  });
  expect(fresh.ok(), await fresh.text()).toBe(true);

  expect(await prisma.recipient.count({ where: { envelopeId } })).toBe(recipients.length + 1);
});

test('[REASSIGN][RT3-L4]: role refusals answer 403, and an unknown recipient on the sender API is "Recipient not found"', async ({
  page,
  request,
}) => {
  const { team, envelopeId, senderReassign } = await createPendingViaApi(request);

  const unknown = await senderReassign(2_000_000_000, { name: 'Nobody', email: uniqueEmail('nobody') });
  expect(unknown.status()).toBe(404);
  const unknownText = await unknown.text();
  expect(unknownText).toContain('Recipient not found');
  expect(unknownText).not.toContain('signing link');

  // A team manager may not set a purge rule: a 403 for a signed-in user without the role.
  const manager = await seedTeamMember({ teamId: team.id, role: 'MANAGER' });
  await apiSignin({ page, email: manager.email });

  const purge = await page.context().request.post(`${webappUrl}/api/trpc/lifecycle.updateSettings`, {
    headers: { ...WEBAPP_ORIGIN_HEADERS, 'content-type': 'application/json', 'x-team-id': String(team.id) },
    data: JSON.stringify({
      json: {
        scope: { type: 'team', teamId: team.id },
        data: {
          retentionSettings: {
            enabled: true,
            action: 'PURGE',
            days: 30,
            includeRejected: false,
            includeCancelled: false,
          },
        },
      },
    }),
  });
  expect(purge.status()).toBe(403);

  // A plain member may not host in-person signing.
  const member = await seedTeamMember({ teamId: team.id, role: 'MEMBER' });
  await page.context().clearCookies();
  await apiSignin({ page, email: member.email });

  const host = await page.context().request.post(`${webappUrl}/api/trpc/inPerson.start`, {
    headers: { ...WEBAPP_ORIGIN_HEADERS, 'content-type': 'application/json', 'x-team-id': String(team.id) },
    data: JSON.stringify({ json: { envelopeId, pin: '4826', emailCodeRecipientIds: [] } }),
  });
  expect(host.status()).toBe(403);
});
