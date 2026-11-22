import fs from 'node:fs';
import path from 'node:path';
import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { jobs } from '@documenso/lib/jobs/client';
import { createApiToken } from '@documenso/lib/server-only/public-api/create-api-token';
import { getTeamSmsSettings } from '@documenso/lib/server-only/sms/get-team-sms-settings';
import { FAKE_SMS_NUMBERS } from '@documenso/lib/server-only/sms/providers/fake';
import { mapSecondaryIdToDocumentId } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';
import { EnvelopeType, RecipientRole } from '@documenso/prisma/client';
import { seedOrganisationMembers } from '@documenso/prisma/seed/organisations';
import { seedTeamMember } from '@documenso/prisma/seed/teams';
import { seedUser } from '@documenso/prisma/seed/users';
import type {
  TCreateEnvelopePayload,
  TCreateEnvelopeResponse,
} from '@documenso/trpc/server/envelope-router/create-envelope.types';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { customAlphabet } from 'nanoid';

import { apiSignin, WEBAPP_ORIGIN_HEADERS } from '../fixtures/authentication';

const baseUrl = `${NEXT_PUBLIC_WEBAPP_URL()}/api/v2-beta`;

const examplePdf = fs.readFileSync(path.join(__dirname, '../../../../assets/example.pdf'));

// Unique numbers per test so parallel runs never read each other's outbox rows.
const randomDigits = customAlphabet('0123456789', 7);
const uniqueNumber = () => `+1415${randomDigits()}`.replace(/^\+1415([01])/, '+14152');

test.describe.configure({ mode: 'parallel' });

type TSetupOptions = {
  orgSmsEnabled?: boolean;
  teamSmsEnabled?: boolean | null;
};

const setup = async ({ orgSmsEnabled = true, teamSmsEnabled = null }: TSetupOptions = {}) => {
  const { user, organisation, team } = await seedUser();

  await prisma.organisationSmsSettings.create({
    data: { organisationId: organisation.id, enabled: orgSmsEnabled, senderLabel: 'Acme Sign' },
  });

  if (teamSmsEnabled !== null) {
    await prisma.teamSmsSettings.create({ data: { teamId: team.id, enabled: teamSmsEnabled } });
  }

  const { token } = await createApiToken({ userId: user.id, teamId: team.id, tokenName: 'sms', expiresIn: null });

  return { user, organisation, team, token };
};

const createEnvelope = async (
  request: APIRequestContext,
  token: string,
  options: { signingChannel: 'EMAIL' | 'SMS' | 'EMAIL_AND_SMS'; recipients: { email: string; name: string }[] },
) => {
  const payload: TCreateEnvelopePayload = {
    type: EnvelopeType.DOCUMENT,
    title: 'Lease, "unit 4"',
    meta: { signingChannel: options.signingChannel },
    recipients: options.recipients.map((recipient) => ({
      ...recipient,
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
    })),
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

  const recipients = await prisma.recipient.findMany({ where: { envelopeId }, orderBy: { id: 'asc' } });

  return { envelopeId, recipients };
};

const setPhone = async (
  request: APIRequestContext,
  token: string,
  data: { envelopeId: string; recipientId: number; phoneNumber: string | null },
) =>
  await request.post(`${baseUrl}/envelope/recipient/phone/set`, {
    headers: { Authorization: `Bearer ${token}` },
    data,
  });

const distribute = async (request: APIRequestContext, token: string, envelopeId: string) => {
  const res = await request.post(`${baseUrl}/envelope/distribute`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { envelopeId },
  });

  expect(res.ok()).toBeTruthy();
};

const auditTypes = async (envelopeId: string) =>
  (await prisma.documentAuditLog.findMany({ where: { envelopeId }, orderBy: { createdAt: 'asc' } })).map(
    (log) => log.type,
  );

test('[SMS]: text-only envelope texts the link, marks the recipient sent and sends no email', async ({ request }) => {
  const { token } = await setup();
  const phone = uniqueNumber();

  const { envelopeId, recipients } = await createEnvelope(request, token, {
    signingChannel: 'SMS',
    recipients: [{ email: 'sms-only@test.documenso.com', name: 'Text Only' }],
  });

  const recipient = recipients[0];

  // The sender types a local US number; the server stores E.164.
  const phoneRes = await setPhone(request, token, {
    envelopeId,
    recipientId: recipient.id,
    phoneNumber: phone.replace('+1', '').replace(/(\d{3})(\d{3})(\d{4})/, '($1) $2-$3'),
  });

  expect(phoneRes.ok()).toBeTruthy();
  expect((await phoneRes.json()).phoneE164).toBe(phone);

  await distribute(request, token, envelopeId);

  await expect
    .poll(async () => await prisma.smsFakeOutbox.findMany({ where: { toE164: phone } }), { timeout: 20_000 })
    .toHaveLength(1);

  const [text] = await prisma.smsFakeOutbox.findMany({ where: { toE164: phone } });

  expect(text.body).toBe(
    `Acme Sign: please sign "Lease, "unit 4"" ${NEXT_PUBLIC_WEBAPP_URL()}/sign/${recipient.token} Reply STOP to opt out.`,
  );

  await expect
    .poll(async () => (await prisma.recipient.findUniqueOrThrow({ where: { id: recipient.id } })).sendStatus)
    .toBe('SENT');

  const updated = await prisma.recipient.findUniqueOrThrow({ where: { id: recipient.id } });

  // Expiry is set at send time for every channel; reminders start from the text.
  expect(updated.sentAt).not.toBeNull();
  expect(updated.expiresAt).not.toBeNull();

  const logs = await prisma.documentAuditLog.findMany({ where: { envelopeId, type: 'SMS_SENT' } });

  expect(logs).toHaveLength(1);
  expect(logs[0].data).toMatchObject({
    recipientId: recipient.id,
    phoneNumberMasked: `*******${phone.slice(-4)}`,
    purpose: 'SIGNING_REQUEST',
    provider: 'fake',
  });
  expect(JSON.stringify(logs[0].data)).not.toContain(phone);

  expect(await auditTypes(envelopeId)).not.toContain('EMAIL_SENT');
});

test('[SMS]: a second job for the same recipient does not text twice', async ({ request }) => {
  const { token, user } = await setup();
  const phone = uniqueNumber();

  const { envelopeId, recipients } = await createEnvelope(request, token, {
    signingChannel: 'SMS',
    recipients: [{ email: 'sms-dup@test.documenso.com', name: 'Dup' }],
  });

  await setPhone(request, token, { envelopeId, recipientId: recipients[0].id, phoneNumber: phone });
  await distribute(request, token, envelopeId);

  await expect
    .poll(async () => await prisma.smsFakeOutbox.count({ where: { toE164: phone } }), { timeout: 20_000 })
    .toBe(1);

  const envelope = await prisma.envelope.findUniqueOrThrow({ where: { id: envelopeId } });

  // Same job the send path queues, triggered again as a retry or a duplicate would be.
  await jobs.triggerJob({
    name: 'send.signing.requested.email',
    payload: {
      userId: user.id,
      documentId: mapSecondaryIdToDocumentId(envelope.secondaryId),
      recipientId: recipients[0].id,
    },
  });

  await expect
    .poll(
      async () =>
        await prisma.backgroundJob.count({
          where: {
            name: 'Send Signing Email',
            status: 'COMPLETED',
            payload: { path: ['recipientId'], equals: recipients[0].id },
          },
        }),
      { timeout: 20_000 },
    )
    .toBe(2);

  expect(await prisma.smsFakeOutbox.count({ where: { toE164: phone } })).toBe(1);
  expect(await prisma.smsMessage.count({ where: { recipientId: recipients[0].id } })).toBe(1);
});

test('[SMS]: text-only recipient without a number gets the email and the failure is recorded', async ({ request }) => {
  const { token } = await setup();

  const { envelopeId, recipients } = await createEnvelope(request, token, {
    signingChannel: 'SMS',
    recipients: [{ email: 'sms-nophone@test.documenso.com', name: 'No Phone' }],
  });

  await distribute(request, token, envelopeId);

  await expect.poll(async () => await auditTypes(envelopeId), { timeout: 20_000 }).toContain('EMAIL_SENT');

  const failed = await prisma.documentAuditLog.findFirstOrThrow({ where: { envelopeId, type: 'SMS_FAILED' } });

  expect(failed.data).toMatchObject({ recipientId: recipients[0].id, reason: 'NO_PHONE', phoneNumberMasked: null });
});

test('[SMS]: provider failure keeps the email, records SMS_FAILED and shows it to the sender', async ({
  page,
  request,
}) => {
  const { token, user, team } = await setup();

  const { envelopeId, recipients } = await createEnvelope(request, token, {
    signingChannel: 'EMAIL_AND_SMS',
    recipients: [{ email: 'sms-down@test.documenso.com', name: 'Provider Down' }],
  });

  await setPhone(request, token, {
    envelopeId,
    recipientId: recipients[0].id,
    phoneNumber: FAKE_SMS_NUMBERS.SERVER_ERROR,
  });

  await distribute(request, token, envelopeId);

  await expect.poll(async () => await auditTypes(envelopeId), { timeout: 20_000 }).toContain('EMAIL_SENT');

  const failed = await prisma.documentAuditLog.findFirstOrThrow({ where: { envelopeId, type: 'SMS_FAILED' } });

  expect(failed.data).toMatchObject({ reason: 'PROVIDER_ERROR', providerErrorCode: 'HTTP_503' });

  const message = await prisma.smsMessage.findFirstOrThrow({ where: { recipientId: recipients[0].id } });

  expect(message).toMatchObject({ status: 'FAILED', isRetryable: true });

  const envelope = await prisma.envelope.findUniqueOrThrow({ where: { id: envelopeId } });

  await apiSignin({ page, email: user.email, redirectPath: `/t/${team.url}/documents/${envelope.id}` });

  const card = page.getByTestId('document-sms-status');

  await expect(card).toBeVisible();
  await expect(card.getByTestId('sms-status-badge')).toHaveText('Text failed');
  await expect(card).toContainText('*******0103');
});

test('[SMS]: an opted-out number is recorded and never texted again', async ({ request }) => {
  const { token } = await setup();

  const first = await createEnvelope(request, token, {
    signingChannel: 'EMAIL_AND_SMS',
    recipients: [{ email: 'sms-stop@test.documenso.com', name: 'Stop' }],
  });

  await setPhone(request, token, {
    envelopeId: first.envelopeId,
    recipientId: first.recipients[0].id,
    phoneNumber: FAKE_SMS_NUMBERS.OPTED_OUT,
  });

  await distribute(request, token, first.envelopeId);

  await expect
    .poll(async () => await prisma.smsOptOut.findUnique({ where: { phoneE164: FAKE_SMS_NUMBERS.OPTED_OUT } }), {
      timeout: 20_000,
    })
    .not.toBeNull();

  const second = await createEnvelope(request, token, {
    signingChannel: 'EMAIL_AND_SMS',
    recipients: [{ email: 'sms-stop-2@test.documenso.com', name: 'Stop again' }],
  });

  await setPhone(request, token, {
    envelopeId: second.envelopeId,
    recipientId: second.recipients[0].id,
    phoneNumber: FAKE_SMS_NUMBERS.OPTED_OUT,
  });

  await distribute(request, token, second.envelopeId);

  await expect.poll(async () => await auditTypes(second.envelopeId), { timeout: 20_000 }).toContain('EMAIL_SENT');

  const failed = await prisma.documentAuditLog.findFirstOrThrow({
    where: { envelopeId: second.envelopeId, type: 'SMS_FAILED' },
  });

  expect(failed.data).toMatchObject({ reason: 'OPTED_OUT' });

  // The provider was never asked: no message row exists for the second recipient.
  expect(await prisma.smsMessage.count({ where: { recipientId: second.recipients[0].id } })).toBe(0);
});

test('[SMS]: team override off sends email only even when the organisation has texts on', async ({ request }) => {
  const { token } = await setup({ orgSmsEnabled: true, teamSmsEnabled: false });
  const phone = uniqueNumber();

  const { envelopeId, recipients } = await createEnvelope(request, token, {
    signingChannel: 'SMS',
    recipients: [{ email: 'sms-team-off@test.documenso.com', name: 'Team Off' }],
  });

  await setPhone(request, token, { envelopeId, recipientId: recipients[0].id, phoneNumber: phone });
  await distribute(request, token, envelopeId);

  await expect.poll(async () => await auditTypes(envelopeId), { timeout: 20_000 }).toContain('EMAIL_SENT');

  expect(await prisma.smsFakeOutbox.count({ where: { toE164: phone } })).toBe(0);
  expect(await auditTypes(envelopeId)).not.toContain('SMS_FAILED');
});

test('[SMS]: manual resend and reminders text again with their own message', async ({ request }) => {
  const { token } = await setup();
  const phone = uniqueNumber();

  const { envelopeId, recipients } = await createEnvelope(request, token, {
    signingChannel: 'SMS',
    recipients: [{ email: 'sms-resend@test.documenso.com', name: 'Resend' }],
  });

  await setPhone(request, token, { envelopeId, recipientId: recipients[0].id, phoneNumber: phone });
  await distribute(request, token, envelopeId);

  await expect
    .poll(async () => await prisma.smsFakeOutbox.count({ where: { toE164: phone } }), { timeout: 20_000 })
    .toBe(1);

  const resendRes = await request.post(`${baseUrl}/envelope/redistribute`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { envelopeId, recipients: [recipients[0].id] },
  });

  expect(resendRes.ok()).toBeTruthy();

  const texts = await prisma.smsFakeOutbox.findMany({ where: { toE164: phone }, orderBy: { createdAt: 'asc' } });

  expect(texts).toHaveLength(2);
  expect(texts[1].body).toMatch(/^Acme Sign: reminder, please sign /);

  // Reminder job, as the sweep queues it once nextReminderAt has passed.
  await prisma.recipient.update({
    where: { id: recipients[0].id },
    data: { nextReminderAt: new Date(Date.now() - 1000) },
  });

  await jobs.triggerJob({ name: 'internal.process-signing-reminder', payload: { recipientId: recipients[0].id } });

  await expect
    .poll(async () => await prisma.smsFakeOutbox.count({ where: { toE164: phone } }), { timeout: 20_000 })
    .toBe(3);

  const purposes = (await prisma.smsMessage.findMany({ where: { recipientId: recipients[0].id } })).map(
    (m) => m.purpose,
  );

  expect(purposes.sort()).toEqual(['REMINDER', 'RESEND', 'SIGNING_REQUEST']);
  expect(await auditTypes(envelopeId)).not.toContain('EMAIL_SENT');
});

test('[SMS]: phone numbers are validated on the server and refused without envelope access', async ({ request }) => {
  const { token } = await setup();
  const other = await setup();

  const { envelopeId, recipients } = await createEnvelope(request, token, {
    signingChannel: 'SMS',
    recipients: [{ email: 'sms-validate@test.documenso.com', name: 'Validate' }],
  });

  const invalid = await setPhone(request, token, { envelopeId, recipientId: recipients[0].id, phoneNumber: '555-12' });

  expect(invalid.status()).toBe(400);

  const foreign = await setPhone(request, other.token, {
    envelopeId,
    recipientId: recipients[0].id,
    phoneNumber: uniqueNumber(),
  });

  expect(foreign.ok()).toBeFalsy();
  expect(await prisma.recipientSmsChannel.count({ where: { recipientId: recipients[0].id } })).toBe(0);
});

test('[SMS]: the editor shows the phone field and the channel choice when texts are on', async ({ page }) => {
  const { user, team, token } = await setup();

  const { envelopeId, recipients } = await createEnvelope(page.request, token, {
    signingChannel: 'EMAIL',
    recipients: [{ email: 'sms-editor@test.documenso.com', name: 'Editor' }],
  });

  await apiSignin({ page, email: user.email, redirectPath: `/t/${team.url}/documents/${envelopeId}/edit` });

  const phoneInput = page.getByTestId('signer-phone-input').first();

  await expect(phoneInput).toBeVisible();

  await phoneInput.fill('12');
  await phoneInput.blur();
  await expect(page.getByTestId('signer-phone-error')).toBeVisible();

  const phone = uniqueNumber();

  await phoneInput.fill(phone);
  await phoneInput.blur();
  await expect(page.getByTestId('signer-phone-consent')).toBeVisible();

  await expect
    .poll(
      async () =>
        (await prisma.recipientSmsChannel.findUnique({ where: { recipientId: recipients[0].id } }))?.phoneE164,
    )
    .toBe(phone);

  await page.getByRole('button', { name: 'Settings' }).first().click();
  await page.getByRole('button', { name: 'Notifications' }).click();
  await page.getByTestId('signing-channel-select').click();
  await page.getByRole('option', { name: 'Text message', exact: true }).click();
  await page.getByRole('button', { name: 'Update' }).click();

  await expect
    .poll(
      async () => (await prisma.documentMeta.findFirst({ where: { envelope: { id: envelopeId } } }))?.signingChannel,
    )
    .toBe('SMS');
});

test('[SMS]: organisation admins turn texts on and teams override them in settings', async ({ page }) => {
  const { user, organisation, team } = await seedUser();

  await apiSignin({ page, email: user.email, redirectPath: `/o/${organisation.url}/settings/sms` });

  await expect(page.getByText('Only text people who agreed to receive texts from you.')).toBeVisible();

  await page.getByTestId('sms-enabled-select').click();
  await page.getByRole('option', { name: 'On', exact: true }).click();
  await page.getByTestId('sms-sender-label-input').fill('  Acme     Sign  ');
  await page.getByRole('button', { name: 'Save changes' }).click();

  await expect
    .poll(async () => await prisma.organisationSmsSettings.findUnique({ where: { organisationId: organisation.id } }))
    .toMatchObject({ enabled: true, senderLabel: 'Acme Sign' });

  await page.goto(`/t/${team.url}/settings/sms`);

  await expect(page.getByTestId('sms-enabled-status')).toHaveText('Inherited');

  await page.getByTestId('sms-enabled-select').click();
  await page.getByRole('option', { name: 'Off', exact: true }).click();
  await page.getByRole('button', { name: 'Save changes' }).click();

  await expect
    .poll(async () => await prisma.teamSmsSettings.findUnique({ where: { teamId: team.id } }))
    .toMatchObject({ enabled: false, senderLabel: null });
});

test('[SMS][S-M4]: only allowed countries, only admins set the sender name, a team cannot override the organisation', async ({
  page,
  request,
}) => {
  const { token, organisation, team } = await setup({ orgSmsEnabled: false });

  const { envelopeId, recipients } = await createEnvelope(request, token, {
    signingChannel: 'SMS',
    recipients: [{ email: 'sms-country@test.documenso.com', name: 'Country' }],
  });

  // Premium and international numbers are refused (default: +1 only).
  for (const premium of ['+8823456789012', '+2348012345678']) {
    const refused = await setPhone(request, token, { envelopeId, recipientId: recipients[0].id, phoneNumber: premium });
    expect(refused.ok()).toBe(false);
    expect(await refused.text()).toContain('numbers starting with +1');
  }

  expect(await prisma.recipientSmsChannel.count({ where: { recipientId: recipients[0].id } })).toBe(0);

  // The same on a sent document, where a number change is a handover.
  await prisma.organisationSmsSettings.update({ where: { organisationId: organisation.id }, data: { enabled: true } });
  const sentPhone = uniqueNumber();
  const validPhone = await setPhone(request, token, {
    envelopeId,
    recipientId: recipients[0].id,
    phoneNumber: sentPhone,
  });
  expect(validPhone.ok(), await validPhone.text()).toBe(true);
  await distribute(request, token, envelopeId);

  const premiumAfterSend = await setPhone(request, token, {
    envelopeId,
    recipientId: recipients[0].id,
    phoneNumber: '+8823456789012',
  });
  expect(premiumAfterSend.ok()).toBe(false);
  expect(await premiumAfterSend.text()).toContain('numbers starting with +1');
  expect((await prisma.recipientSmsChannel.findUnique({ where: { recipientId: recipients[0].id } }))?.phoneE164).toBe(
    sentPhone,
  );

  await prisma.organisationSmsSettings.update({ where: { organisationId: organisation.id }, data: { enabled: false } });

  // A team manager cannot turn texts on over the organisation, nor pick a sender name.
  const manager = await seedTeamMember({ teamId: team.id, role: 'MANAGER' });
  await apiSignin({ page, email: manager.email });

  const trpcPost = async (path: string, json: Record<string, unknown>) =>
    await page.context().request.post(`${NEXT_PUBLIC_WEBAPP_URL()}/api/trpc/${path}`, {
      headers: { ...WEBAPP_ORIGIN_HEADERS, 'content-type': 'application/json', 'x-team-id': String(team.id) },
      data: JSON.stringify({ json }),
    });

  const turnOn = await trpcPost('sms.updateTeamSettings', { teamId: team.id, enabled: true });
  expect(turnOn.ok()).toBe(false);
  expect(await turnOn.text()).toContain('off for your organisation');

  const label = await trpcPost('sms.updateTeamSettings', {
    teamId: team.id,
    enabled: false,
    senderLabel: 'Chase Bank',
  });
  expect(label.ok()).toBe(false);
  expect(await label.text()).toContain('Only an organisation admin');

  // Turning texts off for the team is fine.
  const turnOff = await trpcPost('sms.updateTeamSettings', { teamId: team.id, enabled: false });
  expect(turnOff.ok(), await turnOff.text()).toBe(true);

  // A team row that says "on" from before this rule does not override an organisation that is off.
  await prisma.teamSmsSettings.update({ where: { teamId: team.id }, data: { enabled: true } });
  const effective = await getTeamSmsSettings({ teamId: team.id });
  expect(effective.isEnabled).toBe(false);

  // An organisation manager (not admin) cannot set the organisation's sender name either.
  const { user: orgManager } = await seedUser();
  await seedOrganisationMembers({
    members: [{ name: orgManager.name ?? '', email: orgManager.email, organisationRole: 'MANAGER' }],
    organisationId: organisation.id,
  });

  await page.context().clearCookies();
  await apiSignin({ page, email: orgManager.email });

  const orgLabel = await trpcPost('sms.updateOrganisationSettings', {
    organisationId: organisation.id,
    senderLabel: 'Chase Bank',
  });
  expect(orgLabel.ok()).toBe(false);
  expect(await orgLabel.text()).toContain('Only an organisation admin');
  expect(
    (await prisma.organisationSmsSettings.findUnique({ where: { organisationId: organisation.id } }))?.senderLabel,
  ).toBe('Acme Sign');
});

test('[SMS][SEC2-M3]: without a sender label a text names the organisation, never a team name a manager chose', async ({
  page,
  request,
}) => {
  const { token, organisation, team } = await setup();

  // No label at either level: the fallback decides what the text starts with.
  await prisma.organisationSmsSettings.update({
    where: { organisationId: organisation.id },
    data: { senderLabel: null },
  });

  // A team manager renames the team to look like a bank.
  const manager = await seedTeamMember({ teamId: team.id, role: 'MANAGER' });
  await apiSignin({ page, email: manager.email });

  const rename = await page.context().request.post(`${NEXT_PUBLIC_WEBAPP_URL()}/api/trpc/team.update`, {
    headers: { ...WEBAPP_ORIGIN_HEADERS, 'content-type': 'application/json', 'x-team-id': String(team.id) },
    data: JSON.stringify({ json: { teamId: team.id, data: { name: 'Chase Bank Fraud Dept', url: team.url } } }),
  });
  expect(rename.ok(), await rename.text()).toBe(true);

  const phone = uniqueNumber();
  const { envelopeId, recipients } = await createEnvelope(request, token, {
    signingChannel: 'SMS',
    recipients: [{ email: 'sms-label@test.documenso.com', name: 'Label' }],
  });

  expect((await setPhone(request, token, { envelopeId, recipientId: recipients[0].id, phoneNumber: phone })).ok()).toBe(
    true,
  );
  await distribute(request, token, envelopeId);

  await expect
    .poll(async () => await prisma.smsFakeOutbox.count({ where: { toE164: phone } }), { timeout: 20_000 })
    .toBe(1);

  const [text] = await prisma.smsFakeOutbox.findMany({ where: { toE164: phone } });
  const { name: organisationName } = await prisma.organisation.findUniqueOrThrow({ where: { id: organisation.id } });

  expect(text.body).not.toContain('Chase Bank');
  expect(text.body.startsWith(`${organisationName.slice(0, 40)}:`)).toBe(true);
});

test('[SMS]: plain team members see masked mobile numbers; the owner sees the full number', async ({
  page,
  request,
}) => {
  const { token, user, team } = await setup();
  const phone = uniqueNumber();

  const { envelopeId, recipients } = await createEnvelope(request, token, {
    signingChannel: 'SMS',
    recipients: [{ email: 'sms-mask@test.documenso.com', name: 'Masked' }],
  });
  await setPhone(request, token, { envelopeId, recipientId: recipients[0].id, phoneNumber: phone });

  const statusFor = async () => {
    const response = await page
      .context()
      .request.get(
        `${NEXT_PUBLIC_WEBAPP_URL()}/api/trpc/sms.getEnvelopeStatus?input=${encodeURIComponent(JSON.stringify({ json: { envelopeId } }))}`,
        { headers: { ...WEBAPP_ORIGIN_HEADERS, 'x-team-id': String(team.id) } },
      );
    expect(response.ok(), await response.text()).toBe(true);

    return (await response.json()).result.data.json.recipients[0].phoneE164 as string;
  };

  await apiSignin({ page, email: user.email });
  expect(await statusFor()).toBe(phone);

  const member = await seedTeamMember({ teamId: team.id, role: 'MEMBER' });
  await page.context().clearCookies();
  await apiSignin({ page, email: member.email });

  const masked = await statusFor();
  expect(masked).not.toContain(phone.slice(2, 8));
  expect(masked.endsWith(phone.slice(-4))).toBe(true);
});

test('[SMS][RT2-L4]: +1 premium-rate and non-US/Canada NANP numbers are refused', async ({ request }) => {
  const { token } = await setup();

  const { envelopeId, recipients } = await createEnvelope(request, token, {
    signingChannel: 'SMS',
    recipients: [{ email: 'sms-nanp@test.documenso.com', name: 'NANP' }],
  });

  for (const phoneNumber of ['+19005550123', '+19765550123', '+18765550123', '+18095550123']) {
    const refused = await setPhone(request, token, { envelopeId, recipientId: recipients[0].id, phoneNumber });
    expect(refused.ok(), phoneNumber).toBe(false);
    expect(await refused.text()).toContain('premium-rate');
  }

  const allowed = await setPhone(request, token, {
    envelopeId,
    recipientId: recipients[0].id,
    phoneNumber: uniqueNumber(),
  });
  expect(allowed.ok(), await allowed.text()).toBe(true);
});
