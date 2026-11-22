import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { generateTwoFactorTokenFromEmail } from '@documenso/lib/server-only/2fa/email/generate-2fa-token-from-email';
import { completeDocumentWithToken } from '@documenso/lib/server-only/document/complete-document-with-token';
import { DOCUMENT_AUDIT_LOG_TYPE } from '@documenso/lib/types/document-audit-logs';
import { prisma } from '@documenso/prisma';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { DocumentStatus, SigningStatus } from '@prisma/client';

import { apiSeedPendingDocument } from '../fixtures/api-seeds';
import { apiSignin, WEBAPP_ORIGIN_HEADERS } from '../fixtures/authentication';
import { getCanvasBox, getPageCanvas } from '../fixtures/contents';
import { waitForHydration } from '../fixtures/hydration';

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();

test.describe.configure({ mode: 'parallel' });

const PIN = '4826';

const uniqueEmail = (label: string) =>
  `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.documenso.com`;

/** The default seeded signature field for the recipient at `index` (see apiSeedPendingDocument). */
const defaultSignatureField = (index: number) => ({ positionX: 10, positionY: 10 + index * 10, width: 15, height: 5 });

const seedTwoSigners = async (request: APIRequestContext, options: { sequential?: boolean } = {}) => {
  const signers = [
    { email: uniqueEmail('first'), name: 'First Signer', signingOrder: 1 },
    { email: uniqueEmail('second'), name: 'Second Signer', signingOrder: 2 },
  ];

  const seeded = await apiSeedPendingDocument(request, {
    title: '[TEST] In person',
    recipients: signers,
    meta: options.sequential ? { signingOrder: 'SEQUENTIAL' } : undefined,
  });

  const recipients = await prisma.recipient.findMany({
    where: { envelopeId: seeded.envelope.id },
    orderBy: { id: 'asc' },
  });

  return { ...seeded, recipients };
};

const trpcPost = async (page: Page, path: string, input: unknown, teamId?: number) =>
  await page.context().request.post(`${WEBAPP_BASE_URL}/api/trpc/${path}`, {
    headers: {
      ...WEBAPP_ORIGIN_HEADERS,
      'content-type': 'application/json',
      ...(teamId ? { 'x-team-id': String(teamId) } : {}),
    },
    data: JSON.stringify({ json: input }),
  });

const startSessionViaApi = async (
  page: Page,
  input: { envelopeId: string; teamId: number; emailCodeRecipientIds?: number[] },
) => {
  const response = await trpcPost(
    page,
    'inPerson.start',
    { envelopeId: input.envelopeId, pin: PIN, emailCodeRecipientIds: input.emailCodeRecipientIds ?? [] },
    input.teamId,
  );

  expect(response.ok(), await response.text()).toBe(true);

  const body = await response.json();

  return body.result.data.json.sessionId as string;
};

const confirmName = async (page: Page, name: string) => {
  await expect(page.getByTestId('in-person-handover')).toBeVisible();
  await waitForHydration(page, '#in-person-name');

  // Fresh page load: retry until the form is hydrated.
  await expect(async () => {
    await page.getByLabel('Your full name').fill(name);
    await expect(page.getByRole('button', { name: 'Confirm and continue' })).toBeEnabled({ timeout: 500 });
  }).toPass();

  await page.getByRole('button', { name: 'Confirm and continue' }).click();
};

const handOver = async (page: Page, recipientId: number) => {
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
};

// Each in-person screen change is a full page load started by a form. `waitForURL` can see that
// navigation aborted and the frame swapped (net::ERR_ABORTED), so wait for the new page's own
// element and then check the address.
const expectInPersonPage = async (page: Page, path: string, marker: Locator) => {
  await expect(marker).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(path);
};

const signOnSigningPage = async (page: Page, sessionId: string, fieldIndex: number) => {
  await expectInPersonPage(page, `/in-person/${sessionId}/sign`, page.getByTestId('in-person-signing-bar'));
  await expect(getPageCanvas(page)).toBeVisible({ timeout: 30_000 });

  await page.getByTestId('signature-pad-dialog-button').click();
  await page.getByRole('tab', { name: 'Type' }).click();
  await page.getByTestId('signature-pad-type-input').fill('Signature');
  await page.getByRole('button', { name: 'Next' }).click();

  const field = defaultSignatureField(fieldIndex);
  const canvasBox = await getCanvasBox(page);

  await getPageCanvas(page).click({
    position: {
      x: ((field.positionX + field.width / 2) / 100) * canvasBox.width,
      y: ((field.positionY + field.height / 2) / 100) * canvasBox.height,
    },
  });

  await expect(page.getByText('0 Fields Remaining').first()).toBeVisible({ timeout: 10_000 });

  await page.getByRole('button', { name: 'Complete' }).click();
  await page.getByRole('button', { name: 'Sign' }).click();
};

const unlockWithPin = async (page: Page, pin = PIN) => {
  await expect(page.getByTestId('in-person-handback')).toBeVisible({ timeout: 30_000 });

  const form = page.getByTestId('in-person-unlock-form');

  await waitForHydration(page, '[data-testid="in-person-unlock-form"] input');

  // The screen is a fresh page load; retry until the form is hydrated.
  await expect(async () => {
    await form.getByLabel('Host PIN').fill(pin);
    await expect(form.getByRole('button', { name: 'Unlock' })).toBeEnabled({ timeout: 500 });
  }).toPass();

  await form.getByRole('button', { name: 'Unlock' }).click();
};

test('[IN_PERSON]: two signers sign one after the other on the host device', async ({ page, request }) => {
  // Two full signing rounds and several page loads.
  test.setTimeout(120_000);

  const { envelope, user, team, recipients } = await seedTwoSigners(request, { sequential: true });
  const [first, second] = recipients;

  // The device's address, as a proxy in front of the app would pass it on.
  await page.setExtraHTTPHeaders({ 'x-forwarded-for': '203.0.113.7' });

  // A saved signature on the host's account must never be offered to a signer.
  await prisma.user.update({ where: { id: user.id }, data: { signature: 'HOST-SAVED-SIGNATURE' } });

  await apiSignin({ page, email: user.email, redirectPath: `/t/${team.url}/documents/${envelope.id}` });

  const card = page.getByTestId('document-in-person');
  await card.getByRole('button', { name: 'Sign in person' }).click();

  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Your PIN (4 to 8 digits)').fill(PIN);
  await dialog.getByLabel('Repeat the PIN').fill(PIN);
  await dialog.getByRole('button', { name: 'Start in-person signing' }).click();

  await page.waitForURL(/\/in-person\/[^/]+$/);
  const sessionId = page.url().split('/in-person/')[1];

  // Sequential: only the first signer can be handed the device.
  await expect(page.getByTestId(`in-person-signer-${second.id}`).getByText('Waiting for their turn')).toBeVisible();
  await handOver(page, first.id);

  await expect(page.getByRole('heading', { name: 'Hand the device to First Signer' })).toBeVisible();

  // A wrong name is refused.
  await page.getByLabel('Your full name').fill('Someone Else');
  await page.getByRole('button', { name: 'Confirm and continue' }).click();
  await expect(page.getByText('The name does not match the name on the document.')).toBeVisible();

  await confirmName(page, 'first signer');

  await expectInPersonPage(page, `/in-person/${sessionId}/sign`, page.getByTestId('in-person-signing-bar'));
  await expect(page.locator('#full-name')).toHaveValue('First Signer');
  await expect(page.getByText(user.name ?? 'no-host-name', { exact: true })).toHaveCount(0);
  await expect(page.getByText('HOST-SAVED-SIGNATURE')).toHaveCount(0);

  await signOnSigningPage(page, sessionId, 0);

  // The device locks: the next signer cannot be started without the host PIN.
  await expectInPersonPage(page, `/in-person/${sessionId}`, page.getByTestId('in-person-handback'));
  await expect(page.getByText('Thank you, First Signer. Your part is done.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hand over to sign' })).toHaveCount(0);

  await unlockWithPin(page);

  await handOver(page, second.id);
  await confirmName(page, 'Second Signer');
  await signOnSigningPage(page, sessionId, 1);

  await expectInPersonPage(page, `/in-person/${sessionId}`, page.getByTestId('in-person-handback'));
  await unlockWithPin(page);

  await expect(page.getByText('Nobody else needs to sign on this device.')).toBeVisible();

  await waitForHydration(page, '[data-testid="in-person-host"] button');
  await page.getByRole('button', { name: 'Exit in-person signing' }).click();
  const exitForm = page.getByTestId('in-person-exit-form');
  await exitForm.getByLabel('Host PIN').fill(PIN);
  await exitForm.getByRole('button', { name: 'Exit in-person signing' }).click();

  await page.waitForURL(`/t/${team.url}/documents/${envelope.id}`);

  await expect
    .poll(async () => (await prisma.envelope.findUniqueOrThrow({ where: { id: envelope.id } })).status, {
      timeout: 30_000,
    })
    .toBe(DocumentStatus.COMPLETED);

  // Evidence: each completion names the host, with IP and user agent.
  const completed = await prisma.documentAuditLog.findMany({
    where: { envelopeId: envelope.id, type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_RECIPIENT_COMPLETED },
  });

  expect(completed).toHaveLength(2);

  for (const log of completed) {
    expect(log.data).toEqual(
      expect.objectContaining({
        inPersonHost: expect.objectContaining({ sessionId, hostUserId: user.id, hostEmail: user.email }),
      }),
    );
    expect(log.ipAddress).toBe('203.0.113.7');
    expect(log.userAgent).toBeTruthy();
  }

  const started = await prisma.documentAuditLog.findMany({
    where: { envelopeId: envelope.id, type: DOCUMENT_AUDIT_LOG_TYPE.IN_PERSON_SIGNER_STARTED },
    orderBy: { createdAt: 'asc' },
  });

  expect(started.map((log) => log.email)).toEqual([first.email, second.email]);
  expect(started.map((log) => log.ipAddress)).toEqual(['203.0.113.7', '203.0.113.7']);
  expect(started[0].data).toEqual(
    expect.objectContaining({ confirmedName: 'first signer', hostEmail: user.email, emailCodeVerified: false }),
  );

  const ended = await prisma.documentAuditLog.findFirst({
    where: { envelopeId: envelope.id, type: DOCUMENT_AUDIT_LOG_TYPE.IN_PERSON_SESSION_ENDED },
  });

  expect(ended?.data).toEqual(expect.objectContaining({ reason: 'EXITED' }));

  // The host's sign-in is usable again.
  await page.goto(`/t/${team.url}/documents`);
  await expect(page).toHaveURL(`/t/${team.url}/documents`);
});

test('[IN_PERSON]: an email code can be required for a signer', async ({ page, request }) => {
  const { envelope, user, team, recipients } = await seedTwoSigners(request);
  const [first] = recipients;

  await apiSignin({ page, email: user.email, redirectPath: `/t/${team.url}/documents/${envelope.id}` });

  const sessionId = await startSessionViaApi(page, {
    envelopeId: envelope.id,
    teamId: team.id,
    emailCodeRecipientIds: [first.id],
  });

  await page.goto(`/in-person/${sessionId}`);
  await handOver(page, first.id);
  await confirmName(page, 'First Signer');

  await expect(page.getByLabel('Email code')).toBeVisible();
  await expect(page.getByText(/We sent a code to f\*+@test\.documenso\.com/)).toBeVisible();

  // The signing page stays closed until the code is entered.
  await page.goto(`/in-person/${sessionId}/sign`);
  await page.waitForURL(`/in-person/${sessionId}`);

  await waitForHydration(page, '#in-person-code');
  await page.getByLabel('Email code').fill('000000');
  await page.getByRole('button', { name: 'Verify and continue' }).click();
  await expect(page.getByText('The code is not correct or has expired.')).toBeVisible();

  const code = await generateTwoFactorTokenFromEmail({ envelopeId: envelope.id, email: first.email });

  await page.getByLabel('Email code').fill(code);
  await page.getByRole('button', { name: 'Verify and continue' }).click();

  await signOnSigningPage(page, sessionId, 0);
  await page.waitForURL(`/in-person/${sessionId}`);

  const completed = await prisma.documentAuditLog.findFirstOrThrow({
    where: { envelopeId: envelope.id, type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_RECIPIENT_COMPLETED },
  });

  expect(completed.data).toEqual(
    expect.objectContaining({ inPersonHost: expect.objectContaining({ emailCodeVerified: true }) }),
  );

  const requested = await prisma.documentAuditLog.count({
    where: { envelopeId: envelope.id, type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_ACCESS_AUTH_2FA_REQUESTED },
  });

  expect(requested).toBe(1);
});

test('[IN_PERSON]: the host account is locked while signers hold the device', async ({ page, request }) => {
  const { envelope, user, team, recipients } = await seedTwoSigners(request);
  const [first] = recipients;

  await apiSignin({ page, email: user.email, redirectPath: `/t/${team.url}/documents/${envelope.id}` });

  const sessionId = await startSessionViaApi(page, { envelopeId: envelope.id, teamId: team.id });

  // App pages lead back to the in-person screen.
  await page.goto(`/t/${team.url}/documents`);
  await page.waitForURL(`/in-person/${sessionId}`);

  await page.goto('/settings/profile');
  await page.waitForURL(`/in-person/${sessionId}`);

  // The host's API is closed to this sign-in.
  const blocked = await page
    .context()
    .request.get(
      `${WEBAPP_BASE_URL}/api/trpc/inPerson.getOptions?input=${encodeURIComponent(JSON.stringify({ json: { envelopeId: envelope.id } }))}`,
      { headers: { ...WEBAPP_ORIGIN_HEADERS, 'x-team-id': String(team.id) } },
    );
  expect(blocked.status()).toBe(403);

  // A signer in the middle of a turn cannot start the next one.
  await handOver(page, first.id);
  await expect(page.getByTestId('in-person-handover')).toBeVisible();

  const skipAhead = await trpcPost(page, 'inPerson.beginHandover', { sessionId, recipientId: recipients[1].id });
  expect(skipAhead.ok()).toBe(false);

  await page.getByRole('button', { name: 'This is not me. Hand the device back.' }).click();
  await expect(page.getByTestId('in-person-handback')).toBeVisible();

  // Another browser cannot use the session at all.
  const stranger = await request.post(`${WEBAPP_BASE_URL}/api/trpc/inPerson.unlock`, {
    headers: { ...WEBAPP_ORIGIN_HEADERS, 'content-type': 'application/json' },
    data: JSON.stringify({ json: { sessionId, pin: PIN } }),
  });
  expect(stranger.status()).toBe(404);

  // Five wrong PINs end the session and sign the device out.
  for (let attempt = 1; attempt <= 4; attempt++) {
    await unlockWithPin(page, '0000');
    await expect(page.getByText(`${5 - attempt} attempts left.`)).toBeVisible();
  }

  await unlockWithPin(page, '0000');
  await expect(page.getByText('Too many wrong PINs.')).toBeVisible();

  const session = await prisma.inPersonSigningSession.findUniqueOrThrow({ where: { id: sessionId } });
  expect(session.endReason).toBe('PIN_LOCKOUT');
  expect(await prisma.session.count({ where: { id: session.authSessionId } })).toBe(0);

  await page.goto(`/t/${team.url}/documents`);
  await page.waitForURL(/\/signin/);
});

test('[IN_PERSON]: declines, remote signing, reassignment and account checks', async ({ page, request }) => {
  const { envelope, user, team, recipients, token } = await seedTwoSigners(request);
  const [first, second] = recipients;

  // A signer who must sign in to their own account is refused with a reason.
  const third = await prisma.recipient.create({
    data: {
      envelopeId: envelope.id,
      email: uniqueEmail('account'),
      name: 'Account Signer',
      token: `inperson-account-${Date.now()}`,
      role: 'SIGNER',
      signingOrder: 3,
      sendStatus: 'SENT',
      authOptions: { accessAuth: ['ACCOUNT'], actionAuth: [] },
    },
  });

  await apiSignin({ page, email: user.email, redirectPath: `/t/${team.url}/documents/${envelope.id}` });

  const sessionId = await startSessionViaApi(page, { envelopeId: envelope.id, teamId: team.id });

  await page.goto(`/in-person/${sessionId}`);

  const accountRow = page.getByTestId(`in-person-signer-${third.id}`);
  await expect(accountRow.getByText('This signer must sign in to their own account to sign.')).toBeVisible();
  await expect(accountRow.getByRole('button', { name: 'Hand over to sign' })).toHaveCount(0);

  const refused = await trpcPost(page, 'inPerson.beginHandover', { sessionId, recipientId: third.id });
  expect(refused.ok()).toBe(false);

  // The first signer's link is used on their own phone while their turn is open here.
  await handOver(page, first.id);
  await confirmName(page, 'First Signer');
  await page.waitForURL(`/in-person/${sessionId}/sign`);

  await prisma.field.updateMany({ where: { recipientId: first.id }, data: { inserted: true, customText: 'Remote' } });
  await completeDocumentWithToken({ token: first.token, id: { type: 'envelopeId', id: envelope.id } });

  await page.goto(`/in-person/${sessionId}/sign`);
  await page.waitForURL(`/in-person/${sessionId}`);
  await expect(page.getByText('Thank you, First Signer. Your part is done.')).toBeVisible();

  const remoteCompletion = await prisma.documentAuditLog.findFirstOrThrow({
    where: { envelopeId: envelope.id, type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_RECIPIENT_COMPLETED },
  });
  expect(remoteCompletion.data).not.toHaveProperty('inPersonHost');

  await unlockWithPin(page);

  // The second signer is reassigned by the sender while holding the device.
  await handOver(page, second.id);
  await confirmName(page, 'Second Signer');
  await page.waitForURL(`/in-person/${sessionId}/sign`);

  const reassigned = await request.post(`${WEBAPP_BASE_URL}/api/v2-beta/envelope/recipient/reassign`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      envelopeId: envelope.id,
      recipientId: second.id,
      name: 'Replacement Signer',
      email: uniqueEmail('replacement'),
    },
  });
  expect(reassigned.ok(), await reassigned.text()).toBe(true);

  await page.goto(`/in-person/${sessionId}/sign`);
  await page.waitForURL(`/in-person/${sessionId}`);
  await expect(page.getByText('This signing request was passed to someone else.')).toBeVisible();

  await unlockWithPin(page);

  // The replacement declines in person.
  await handOver(page, second.id);
  await confirmName(page, 'Replacement Signer');
  await page.waitForURL(`/in-person/${sessionId}/sign`);
  await expect(getPageCanvas(page)).toBeVisible({ timeout: 30_000 });

  await page.getByRole('button', { name: 'Reject Document' }).click();
  await page.getByRole('dialog').getByRole('textbox').fill('Not today');
  await page.getByRole('dialog').getByRole('button', { name: 'Reject Document' }).click();

  await page.waitForURL(`/in-person/${sessionId}`);
  await expect(page.getByText('Replacement Signer declined to sign.')).toBeVisible();

  const rejected = await prisma.documentAuditLog.findFirstOrThrow({
    where: { envelopeId: envelope.id, type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_RECIPIENT_REJECTED },
  });
  expect(rejected.data).toEqual(
    expect.objectContaining({ inPersonHost: expect.objectContaining({ sessionId, hostEmail: user.email }) }),
  );

  const secondAfter = await prisma.recipient.findUniqueOrThrow({ where: { id: second.id } });
  expect(secondAfter.signingStatus).toBe(SigningStatus.REJECTED);
});

test('[IN_PERSON]: an email change mid-turn ends the turn; files attached in person stay out of the host session', async ({
  page,
  request,
  browser,
}) => {
  const { envelope, user, team, token } = await apiSeedPendingDocument(request, {
    title: '[TEST] In person files',
    recipients: [{ email: uniqueEmail('files'), name: 'File Signer' }],
    fieldsPerRecipient: [
      [
        { type: 'SIGNATURE', page: 1, positionX: 5, positionY: 5, width: 20, height: 5 },
        {
          type: 'FILE',
          page: 1,
          positionX: 5,
          positionY: 30,
          width: 40,
          height: 6,
          fieldMeta: { type: 'file', label: 'Proof of address' },
        },
      ],
    ],
  });

  const [recipient] = await prisma.recipient.findMany({ where: { envelopeId: envelope.id } });
  const fileField = await prisma.field.findFirstOrThrow({ where: { recipientId: recipient.id, type: 'FILE' } });

  await apiSignin({ page, email: user.email, redirectPath: `/t/${team.url}/documents/${envelope.id}` });

  const sessionId = await startSessionViaApi(page, { envelopeId: envelope.id, teamId: team.id });

  await page.goto(`/in-person/${sessionId}`);
  await handOver(page, recipient.id);
  await confirmName(page, 'File Signer');
  await page.waitForURL(`/in-person/${sessionId}/sign`);

  // The sender changes the signer's email from another device while the device is handed over.
  // That is a reassignment (new link token), so the turn ends and the device locks.
  const newEmail = uniqueEmail('changed');

  const changed = await request.post(`${WEBAPP_BASE_URL}/api/v2-beta/envelope/recipient/update-many`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { envelopeId: envelope.id, data: [{ id: recipient.id, email: newEmail }] },
  });
  expect(changed.ok(), await changed.text()).toBe(true);

  await page.goto(`/in-person/${sessionId}/sign`);
  await page.waitForURL(`/in-person/${sessionId}`);
  await expect(page.getByText('This signing request was passed to someone else.')).toBeVisible();

  await unlockWithPin(page);

  // The new person signs in person and attaches a file, by their link token as the signing page does.
  await handOver(page, recipient.id);
  await confirmName(page, 'File Signer');
  await page.waitForURL(`/in-person/${sessionId}/sign`);

  const current = await prisma.recipient.findUniqueOrThrow({ where: { id: recipient.id } });
  expect(current.email).toBe(newEmail);

  const uploaded = await page.context().request.post(`${WEBAPP_BASE_URL}/api/trpc/fieldFile.upload`, {
    headers: WEBAPP_ORIGIN_HEADERS,
    multipart: {
      payload: JSON.stringify({ token: current.token, fieldId: fileField.id }),
      file: {
        name: 'proof.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from(`%PDF-1.4\n% proof ${Math.random()}\n%%EOF\n`),
      },
    },
  });
  expect(uploaded.ok(), await uploaded.text()).toBe(true);

  const upload = await prisma.fieldFileUpload.findFirstOrThrow({ where: { fieldId: fileField.id } });

  const uploadLog = await prisma.documentAuditLog.findFirstOrThrow({
    where: { envelopeId: envelope.id, type: DOCUMENT_AUDIT_LOG_TYPE.FIELD_FILE_UPLOADED },
  });
  expect(uploadLog.email).toBe(newEmail);

  // The signer can fetch their own file by link token.
  const own = await page
    .context()
    .request.get(`${WEBAPP_BASE_URL}/api/files/token/${current.token}/field-file/${upload.id}`);
  expect(own.status()).toBe(200);

  // The host's locked sign-in is treated as signed out for the team routes.
  const viaHostSession = await page
    .context()
    .request.get(`${WEBAPP_BASE_URL}/api/files/envelope/${envelope.id}/field-file/${upload.id}`);
  expect(viaHostSession.status()).toBe(404);

  const listViaHostSession = await page
    .context()
    .request.get(
      `${WEBAPP_BASE_URL}/api/trpc/fieldFile.listForEnvelope?input=${encodeURIComponent(JSON.stringify({ json: { envelopeId: envelope.id } }))}`,
      { headers: { ...WEBAPP_ORIGIN_HEADERS, 'x-team-id': String(team.id) } },
    );
  expect(listViaHostSession.status()).toBe(403);

  // The same user on another, unlocked sign-in downloads it through the normal team route.
  const otherContext = await browser.newContext();
  const otherPage = await otherContext.newPage();
  await apiSignin({ page: otherPage, email: user.email });
  const viaOtherSession = await otherPage
    .context()
    .request.get(`${WEBAPP_BASE_URL}/api/files/envelope/${envelope.id}/field-file/${upload.id}`);
  expect(viaOtherSession.status()).toBe(200);
  await otherContext.close();
});
