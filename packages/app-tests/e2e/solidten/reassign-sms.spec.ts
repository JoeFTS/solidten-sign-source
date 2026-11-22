import fs from 'node:fs';
import path from 'node:path';
import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { jobs } from '@documenso/lib/jobs/client';
import { createApiToken } from '@documenso/lib/server-only/public-api/create-api-token';
import { prisma } from '@documenso/prisma';
import { EnvelopeType, RecipientRole, TeamMemberRole } from '@documenso/prisma/client';
import { seedTeamMember } from '@documenso/prisma/seed/teams';
import { seedUser } from '@documenso/prisma/seed/users';
import type {
  TCreateEnvelopePayload,
  TCreateEnvelopeResponse,
} from '@documenso/trpc/server/envelope-router/create-envelope.types';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { customAlphabet } from 'nanoid';
import { apiSignin, WEBAPP_ORIGIN_HEADERS } from '../fixtures/authentication';
import { expectHandedOverLink } from '../fixtures/signing-links';

const webappUrl = NEXT_PUBLIC_WEBAPP_URL();
const baseUrl = `${webappUrl}/api/v2-beta`;

const examplePdf = fs.readFileSync(path.join(__dirname, '../../../../assets/example.pdf'));

const randomDigits = customAlphabet('0123456789', 7);
const uniqueNumber = () => `+1415${randomDigits()}`.replace(/^\+1415([01])/, '+14152');
const uniqueEmail = (label: string) =>
  `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.documenso.com`;

test.describe.configure({ mode: 'parallel' });

type TChannel = 'SMS' | 'EMAIL_AND_SMS';

/**
 * A sent envelope whose single signer was texted the link.
 */
const createTextedEnvelope = async (
  request: APIRequestContext,
  signingChannel: TChannel,
  options: {
    oldPhone?: string;
    /** Who sets the first number; the owner's API token by default. */
    setInitialPhone?: (data: { envelopeId: string; recipientId: number; phoneNumber: string }) => Promise<void>;
    /** False when the first number must not get a text (the caller checks what happened instead). */
    expectFirstText?: boolean;
  } = {},
) => {
  const { user, organisation, team } = await seedUser();

  await prisma.organisationSmsSettings.create({
    data: { organisationId: organisation.id, enabled: true, senderLabel: 'Acme Sign' },
  });

  const { token } = await createApiToken({ userId: user.id, teamId: team.id, tokenName: 'sms', expiresIn: null });
  const authHeaders = { Authorization: `Bearer ${token}` };

  const payload: TCreateEnvelopePayload = {
    type: EnvelopeType.DOCUMENT,
    title: 'Handover by text',
    meta: { signingChannel },
    recipients: [
      {
        email: uniqueEmail('old'),
        name: 'Old Person',
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

  const createRes = await request.post(`${baseUrl}/envelope/create`, { headers: authHeaders, multipart: formData });
  expect(createRes.ok()).toBeTruthy();

  const { id: envelopeId }: TCreateEnvelopeResponse = await createRes.json();
  const [recipient] = await prisma.recipient.findMany({ where: { envelopeId } });

  const oldPhone = options.oldPhone ?? uniqueNumber();

  if (options.setInitialPhone) {
    await options.setInitialPhone({ envelopeId, recipientId: recipient.id, phoneNumber: oldPhone });
  } else {
    const phoneRes = await request.post(`${baseUrl}/envelope/recipient/phone/set`, {
      headers: authHeaders,
      data: { envelopeId, recipientId: recipient.id, phoneNumber: oldPhone },
    });
    expect(phoneRes.ok()).toBeTruthy();
  }

  const distributeRes = await request.post(`${baseUrl}/envelope/distribute`, {
    headers: authHeaders,
    data: { envelopeId },
  });
  expect(distributeRes.ok()).toBeTruthy();

  if (options.expectFirstText !== false) {
    await expect
      .poll(async () => await prisma.smsFakeOutbox.count({ where: { toE164: oldPhone } }), { timeout: 20_000 })
      .toBe(1);
  }

  return { user, team, envelopeId, recipient, oldPhone, authHeaders };
};

const resendAndRemind = async (
  request: APIRequestContext,
  {
    envelopeId,
    recipientId,
    authHeaders,
  }: { envelopeId: string; recipientId: number; authHeaders: Record<string, string> },
) => {
  const resendRes = await request.post(`${baseUrl}/envelope/redistribute`, {
    headers: authHeaders,
    data: { envelopeId, recipients: [recipientId] },
  });
  expect(resendRes.ok()).toBeTruthy();

  await prisma.recipient.update({ where: { id: recipientId }, data: { nextReminderAt: new Date(Date.now() - 1000) } });
  await jobs.triggerJob({ name: 'internal.process-signing-reminder', payload: { recipientId } });

  // The reminder runs as a job; wait until it has finished before counting texts.
  await expect
    .poll(
      async () =>
        await prisma.backgroundJob.findFirst({
          where: {
            jobId: 'internal.process-signing-reminder',
            payload: { path: ['recipientId'], equals: recipientId },
          },
          select: { status: true },
        }),
      { timeout: 30_000 },
    )
    .toMatchObject({ status: 'COMPLETED' });
};

/**
 * The signing request email that reached the new person, from the EMAIL_SENT audit entry.
 */
const findSigningRequestEmail = async (envelopeId: string, email: string) =>
  await prisma.documentAuditLog.findFirst({
    where: {
      envelopeId,
      type: 'EMAIL_SENT',
      AND: [
        { data: { path: ['recipientEmail'], equals: email } },
        { data: { path: ['emailType'], equals: 'SIGNING_REQUEST' } },
      ],
    },
  });

for (const signingChannel of ['SMS', 'EMAIL_AND_SMS'] as const) {
  test(`[REASSIGN_SMS]: ${signingChannel}: a sender reassign drops the old number and emails the new person`, async ({
    request,
  }) => {
    const { envelopeId, recipient, oldPhone, authHeaders } = await createTextedEnvelope(request, signingChannel);
    const newEmail = uniqueEmail('new');

    const res = await request.post(`${baseUrl}/envelope/recipient/reassign`, {
      headers: authHeaders,
      data: { envelopeId, recipientId: recipient.id, name: 'New Person', email: newEmail },
    });
    expect(res.ok(), await res.text()).toBeTruthy();

    expect(await prisma.recipientSmsChannel.findUnique({ where: { recipientId: recipient.id } })).toBeNull();

    // Whatever the channel, the new person is reached: by email, as they have no number.
    await expect
      .poll(async () => await findSigningRequestEmail(envelopeId, newEmail), { timeout: 30_000 })
      .not.toBeNull();

    await resendAndRemind(request, { envelopeId, recipientId: recipient.id, authHeaders });

    // The old number got the first text and nothing since.
    expect(await prisma.smsFakeOutbox.count({ where: { toE164: oldPhone } })).toBe(1);

    const audit = await prisma.documentAuditLog.findFirstOrThrow({
      where: { envelopeId, type: 'RECIPIENT_REASSIGNED' },
    });
    expect(audit.data).toMatchObject({ trigger: 'REASSIGN', fromPhone: `*******${oldPhone.slice(-4)}`, toPhone: null });
  });
}

test('[REASSIGN_SMS]: a reassign with a new number texts the new link to the new number only', async ({ request }) => {
  const { envelopeId, recipient, oldPhone, authHeaders } = await createTextedEnvelope(request, 'SMS');
  const newPhone = uniqueNumber();

  const res = await request.post(`${baseUrl}/envelope/recipient/reassign`, {
    headers: authHeaders,
    data: {
      envelopeId,
      recipientId: recipient.id,
      name: 'New Person',
      email: uniqueEmail('new'),
      phoneNumber: newPhone,
    },
  });
  expect(res.ok(), await res.text()).toBeTruthy();

  const updated = await prisma.recipient.findUniqueOrThrow({ where: { id: recipient.id } });

  // The first signing request to this recipient id was already used by the old person;
  // the new link must still be texted.
  await expect
    .poll(async () => await prisma.smsFakeOutbox.findMany({ where: { toE164: newPhone } }), { timeout: 30_000 })
    .toHaveLength(1);

  const [text] = await prisma.smsFakeOutbox.findMany({ where: { toE164: newPhone } });
  expect(text.body).toContain(`/sign/${updated.token}`);
  expect(text.body).not.toContain(recipient.token);

  await resendAndRemind(request, { envelopeId, recipientId: recipient.id, authHeaders });

  expect(await prisma.smsFakeOutbox.count({ where: { toE164: oldPhone } })).toBe(1);
  expect(await prisma.smsFakeOutbox.count({ where: { toE164: newPhone } })).toBe(3);
});

test('[REASSIGN_SMS]: a signer passing the request on drops their number', async ({ request }) => {
  const { team, envelopeId, recipient, oldPhone, authHeaders } = await createTextedEnvelope(request, 'EMAIL_AND_SMS');

  const settings = await prisma.team.findUniqueOrThrow({ where: { id: team.id } });
  await prisma.teamGlobalSettings.update({
    where: { id: settings.teamGlobalSettingsId },
    data: { allowSignerReassign: true },
  });

  const newEmail = uniqueEmail('passed-on');

  const res = await request.post(`${webappUrl}/api/trpc/lifecycle.reassignRecipientWithToken`, {
    headers: { Origin: new URL(webappUrl).origin },
    data: { json: { token: recipient.token, name: 'Colleague', email: newEmail } },
  });
  expect(res.ok(), await res.text()).toBeTruthy();

  expect(await prisma.recipientSmsChannel.findUnique({ where: { recipientId: recipient.id } })).toBeNull();

  await resendAndRemind(request, { envelopeId, recipientId: recipient.id, authHeaders });

  expect(await prisma.smsFakeOutbox.count({ where: { toE164: oldPhone } })).toBe(1);
  expect(await findSigningRequestEmail(envelopeId, newEmail)).not.toBeNull();
});

test('[REASSIGN_SMS]: a sender email edit drops the old number', async ({ request }) => {
  const { envelopeId, recipient, oldPhone, authHeaders } = await createTextedEnvelope(request, 'SMS');
  const newEmail = uniqueEmail('edited');

  const res = await request.post(`${baseUrl}/envelope/recipient/update-many`, {
    headers: authHeaders,
    data: { envelopeId, data: [{ id: recipient.id, email: newEmail }] },
  });
  expect(res.ok(), await res.text()).toBeTruthy();

  expect(await prisma.recipientSmsChannel.findUnique({ where: { recipientId: recipient.id } })).toBeNull();

  await expect
    .poll(async () => await findSigningRequestEmail(envelopeId, newEmail), { timeout: 30_000 })
    .not.toBeNull();

  await resendAndRemind(request, { envelopeId, recipientId: recipient.id, authHeaders });

  expect(await prisma.smsFakeOutbox.count({ where: { toE164: oldPhone } })).toBe(1);
});

test('[REASSIGN_SMS]: changing a sent recipient phone number issues a new link to the new number', async ({
  page,
  request,
}) => {
  const { envelopeId, recipient, oldPhone, authHeaders } = await createTextedEnvelope(request, 'SMS');
  const newPhone = uniqueNumber();

  const res = await request.post(`${baseUrl}/envelope/recipient/phone/set`, {
    headers: authHeaders,
    data: { envelopeId, recipientId: recipient.id, phoneNumber: newPhone },
  });
  expect(res.ok(), await res.text()).toBeTruthy();

  const updated = await prisma.recipient.findUniqueOrThrow({ where: { id: recipient.id } });
  expect(updated.token).not.toBe(recipient.token);
  expect(updated.email).toBe(recipient.email);

  // The link texted to the old number no longer opens the document.
  await expectHandedOverLink(page, recipient.token);

  await expect
    .poll(async () => await prisma.smsFakeOutbox.findMany({ where: { toE164: newPhone } }), { timeout: 30_000 })
    .toHaveLength(1);

  const [text] = await prisma.smsFakeOutbox.findMany({ where: { toE164: newPhone } });
  expect(text.body).toContain(`/sign/${updated.token}`);

  const audit = await prisma.documentAuditLog.findFirstOrThrow({ where: { envelopeId, type: 'RECIPIENT_REASSIGNED' } });
  expect(audit.data).toMatchObject({
    trigger: 'PHONE_CHANGE',
    fromPhone: `*******${oldPhone.slice(-4)}`,
    toPhone: `*******${newPhone.slice(-4)}`,
  });

  await resendAndRemind(request, { envelopeId, recipientId: recipient.id, authHeaders });

  expect(await prisma.smsFakeOutbox.count({ where: { toE164: oldPhone } })).toBe(1);
});

test('[REASSIGN_SMS]: removing a sent recipient phone number issues a new link by email', async ({ page, request }) => {
  const { envelopeId, recipient, oldPhone, authHeaders } = await createTextedEnvelope(request, 'SMS');

  const res = await request.post(`${baseUrl}/envelope/recipient/phone/set`, {
    headers: authHeaders,
    data: { envelopeId, recipientId: recipient.id, phoneNumber: null },
  });
  expect(res.ok(), await res.text()).toBeTruthy();

  await expectHandedOverLink(page, recipient.token);
  expect(await prisma.recipientSmsChannel.findUnique({ where: { recipientId: recipient.id } })).toBeNull();

  await expect
    .poll(async () => await findSigningRequestEmail(envelopeId, recipient.email), { timeout: 30_000 })
    .not.toBeNull();

  await resendAndRemind(request, { envelopeId, recipientId: recipient.id, authHeaders });

  expect(await prisma.smsFakeOutbox.count({ where: { toE164: oldPhone } })).toBe(1);
});

test('[REASSIGN_SMS]: the security reviewer steps: a member swaps a premium number after sending, then removes it', async ({
  page,
  request,
}) => {
  // From the security review (S-H2): a recipient already has a premium-rate number stored (from
  // before the area-code rule, RT2-L4, or a rule since narrowed), the document goes out, then a
  // plain team member changes the number and the sender resends. Input checks now refuse +1-900,
  // so the test stores the number directly in the database.
  const premiumLooking = `+1900${randomDigits()}`;
  let memberTeamId = 0;

  const setPhoneAsMember = async (data: { envelopeId: string; recipientId: number; phoneNumber: string | null }) => {
    const res = await page.context().request.post(`${webappUrl}/api/trpc/sms.setRecipientPhone`, {
      headers: { ...WEBAPP_ORIGIN_HEADERS, 'x-team-id': String(memberTeamId) },
      data: { json: data },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
  };

  const { envelopeId, recipient, oldPhone, authHeaders } = await createTextedEnvelope(request, 'SMS', {
    oldPhone: premiumLooking,
    expectFirstText: false,
    setInitialPhone: async (data) => {
      const envelope = await prisma.envelope.findUniqueOrThrow({ where: { id: data.envelopeId } });
      memberTeamId = envelope.teamId;

      const member = await seedTeamMember({ teamId: envelope.teamId, role: TeamMemberRole.MEMBER });
      await apiSignin({ page, email: member.email });

      await prisma.recipientSmsChannel.create({
        data: { recipientId: data.recipientId, phoneE164: data.phoneNumber, status: 'NOT_SENT' },
      });
    },
  });

  // The send re-checks the stored number: no text goes to it.
  await expect
    .poll(
      async () =>
        await prisma.smsMessage.count({
          where: { recipientId: recipient.id, toE164: oldPhone, errorCode: 'COUNTRY_NOT_ALLOWED' },
        }),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);
  expect(await prisma.smsFakeOutbox.count({ where: { toE164: oldPhone } })).toBe(0);

  const newPhone = uniqueNumber();
  await setPhoneAsMember({ envelopeId, recipientId: recipient.id, phoneNumber: newPhone });

  const afterChange = await prisma.recipient.findUniqueOrThrow({ where: { id: recipient.id } });
  expect(afterChange.token).not.toBe(recipient.token);

  await resendAndRemind(request, { envelopeId, recipientId: recipient.id, authHeaders });

  // The resend and reminder text the new number only; the premium number still gets nothing.
  expect(await prisma.smsFakeOutbox.count({ where: { toE164: oldPhone } })).toBe(0);
  expect(await prisma.smsFakeOutbox.count({ where: { toE164: newPhone } })).toBeGreaterThan(0);
  await expectHandedOverLink(page, recipient.token);

  // Removing the number retires the link that went to it as well.
  await setPhoneAsMember({ envelopeId, recipientId: recipient.id, phoneNumber: null });

  const afterRemove = await prisma.recipient.findUniqueOrThrow({ where: { id: recipient.id } });
  expect(afterRemove.token).not.toBe(afterChange.token);
  await expectHandedOverLink(page, afterChange.token);

  // The audit log never holds a full number.
  const entries = await prisma.documentAuditLog.findMany({ where: { envelopeId, type: 'RECIPIENT_REASSIGNED' } });
  expect(entries).toHaveLength(2);

  for (const entry of entries) {
    expect(JSON.stringify(entry.data)).not.toContain(oldPhone.slice(1));
    expect(JSON.stringify(entry.data)).not.toContain(newPhone.slice(1));
  }
});
