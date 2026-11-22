import fs from 'node:fs';
import path from 'node:path';
import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { completeDocumentWithToken } from '@documenso/lib/server-only/document/complete-document-with-token';
import { createApiToken } from '@documenso/lib/server-only/public-api/create-api-token';
import { prisma } from '@documenso/prisma';
import { DocumentSigningOrder, EnvelopeType, RecipientRole } from '@documenso/prisma/client';
import { seedPendingDocumentWithFullFields } from '@documenso/prisma/seed/documents';
import { seedUser } from '@documenso/prisma/seed/users';
import type {
  TCreateEnvelopePayload,
  TCreateEnvelopeResponse,
} from '@documenso/trpc/server/envelope-router/create-envelope.types';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { SendStatus } from '@prisma/client';

import { apiSignin, WEBAPP_ORIGIN_HEADERS } from '../fixtures/authentication';
import { expectHandedOverLink } from '../fixtures/signing-links';

const webappUrl = NEXT_PUBLIC_WEBAPP_URL();
const baseUrl = `${webappUrl}/api/v2-beta`;

const examplePdf = fs.readFileSync(path.join(__dirname, '../../../../assets/example.pdf'));

test.describe.configure({ mode: 'parallel' });

const uniqueEmail = (label: string) =>
  `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.documenso.com`;

const createPendingViaApi = async (request: APIRequestContext, signerCount = 1) => {
  const { user, team } = await seedUser();

  const { token } = await createApiToken({ userId: user.id, teamId: team.id, tokenName: 'handover', expiresIn: null });
  const authHeaders = { Authorization: `Bearer ${token}` };

  const payload: TCreateEnvelopePayload = {
    type: EnvelopeType.DOCUMENT,
    title: '[TEST] Handover paths',
    recipients: Array.from({ length: signerCount }, (_, index) => ({
      email: uniqueEmail(`signer${index + 1}`),
      name: `Signer ${index + 1}`,
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
        { type: 'NAME', page: 1, positionX: 30, positionY: 10, width: 10, height: 5, fieldMeta: { type: 'name' } },
      ],
    })),
  };

  const formData = new FormData();
  formData.append('payload', JSON.stringify(payload));
  formData.append('files', new File([examplePdf], 'example.pdf', { type: 'application/pdf' }));

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

  return { envelopeId, recipients, authHeaders };
};

test('[HANDOVER]: an admin changing a sent recipient email issues a new link and clears their values', async ({
  page,
  request,
}) => {
  const { envelopeId, recipients } = await createPendingViaApi(request);
  const [recipient] = recipients;

  // The old person had typed their name.
  const nameField = recipient.fields.find((field) => field.type === 'NAME');
  await prisma.field.update({ where: { id: nameField?.id }, data: { inserted: true, customText: 'Old typed name' } });

  const { user: admin } = await seedUser({ isAdmin: true });
  await apiSignin({ page, email: admin.email, redirectPath: '/admin' });

  const newEmail = uniqueEmail('admin-new');

  const res = await page.context().request.post(`${webappUrl}/api/trpc/admin.recipient.update`, {
    headers: WEBAPP_ORIGIN_HEADERS,
    data: { json: { id: recipient.id, name: 'Admin Fixed', email: newEmail } },
  });
  expect(res.ok(), await res.text()).toBeTruthy();

  const updated = await prisma.recipient.findUniqueOrThrow({ where: { id: recipient.id }, include: { fields: true } });

  expect(updated.email).toBe(newEmail);
  expect(updated.token).not.toBe(recipient.token);
  expect(updated.fields.find((field) => field.type === 'NAME')?.inserted).toBe(false);

  await expectHandedOverLink(page, recipient.token);

  const audit = await prisma.documentAuditLog.findFirstOrThrow({ where: { envelopeId, type: 'RECIPIENT_REASSIGNED' } });
  expect(audit.userId).toBe(admin.id);
  expect(audit.data).toMatchObject({
    trigger: 'ADMIN_EDIT',
    reassignedBy: 'ADMIN',
    fromEmail: recipient.email,
    toEmail: newEmail,
  });
  // The new person is asked to sign and the old person is told.
  await expect
    .poll(async () =>
      prisma.backgroundJob.count({
        where: { jobId: 'send.signing.requested.email', payload: { path: ['recipientId'], equals: recipient.id } },
      }),
    )
    .toBeGreaterThanOrEqual(1);

  await expect
    .poll(async () =>
      prisma.backgroundJob.count({
        where: {
          jobId: 'send.solidten.notice.email',
          payload: { path: ['oldEmail'], equals: recipient.email },
        },
      }),
    )
    .toBe(1);
});

test('[HANDOVER]: an admin name-only edit keeps the link', async ({ page, request }) => {
  const { envelopeId, recipients } = await createPendingViaApi(request);
  const [recipient] = recipients;

  const { user: admin } = await seedUser({ isAdmin: true });
  await apiSignin({ page, email: admin.email, redirectPath: '/admin' });

  const res = await page.context().request.post(`${webappUrl}/api/trpc/admin.recipient.update`, {
    headers: WEBAPP_ORIGIN_HEADERS,
    data: { json: { id: recipient.id, name: 'Only The Name', email: recipient.email } },
  });
  expect(res.ok(), await res.text()).toBeTruthy();

  const updated = await prisma.recipient.findUniqueOrThrow({ where: { id: recipient.id } });
  expect(updated.name).toBe('Only The Name');
  expect(updated.token).toBe(recipient.token);
  expect(await prisma.documentAuditLog.count({ where: { envelopeId, type: 'RECIPIENT_REASSIGNED' } })).toBe(0);

  // Never unaudited: the name change is recorded with the admin as the actor.
  const audit = await prisma.documentAuditLog.findFirstOrThrow({ where: { envelopeId, type: 'RECIPIENT_UPDATED' } });
  expect(audit.userId).toBe(admin.id);
  expect(audit.data).toMatchObject({
    recipientId: recipient.id,
    changes: [{ type: 'NAME', from: recipient.name, to: 'Only The Name' }],
  });
});

test('[HANDOVER]: dictating a different next signer issues them a new link', async ({ page }) => {
  const { user, team } = await seedUser();
  const [firstSigner, secondSigner] = [(await seedUser()).user, (await seedUser()).user];

  const { recipients } = await seedPendingDocumentWithFullFields({
    owner: user,
    teamId: team.id,
    recipients: [firstSigner, secondSigner],
    recipientsCreateOptions: [
      { signingOrder: 1, sendStatus: SendStatus.SENT },
      { signingOrder: 2, sendStatus: SendStatus.NOT_SENT },
    ],
    fields: [],
    updateDocumentOptions: {
      internalVersion: 2,
      documentMeta: {
        upsert: {
          create: { signingOrder: DocumentSigningOrder.SEQUENTIAL, allowDictateNextSigner: true },
          update: { signingOrder: DocumentSigningOrder.SEQUENTIAL, allowDictateNextSigner: true },
        },
      },
    },
  });

  const first = recipients.find((recipient) => recipient.email === firstSigner.email);
  const second = recipients.find((recipient) => recipient.email === secondSigner.email);

  if (!first || !second) {
    throw new Error('Seeded recipients are missing');
  }

  const dictatedEmail = uniqueEmail('dictated');

  await completeDocumentWithToken({
    token: first.token,
    id: { type: 'envelopeId', id: first.envelopeId },
    nextSigner: { name: 'Dictated Person', email: dictatedEmail },
    requestMetadata: { userAgent: 'handover-spec' },
  });

  const secondAfter = await prisma.recipient.findUniqueOrThrow({ where: { id: second.id } });

  expect(secondAfter.email).toBe(dictatedEmail);
  expect(secondAfter.token).not.toBe(second.token);

  // A link the sender may have copied for the original next signer no longer opens.
  await expectHandedOverLink(page, second.token);

  const audit = await prisma.documentAuditLog.findFirstOrThrow({
    where: { envelopeId: first.envelopeId, type: 'RECIPIENT_REASSIGNED' },
  });
  expect(audit.email).toBe(first.email);
  expect(audit.data).toMatchObject({
    trigger: 'DICTATED_NEXT_SIGNER',
    reassignedBy: 'SIGNER',
    fromEmail: second.email,
    toEmail: dictatedEmail,
  });
});

const TAKEN_MESSAGE = 'This person is already a recipient on this document.';

test('[HANDOVER]: every sender edit path refuses an email another recipient already has', async ({ page, request }) => {
  const { envelopeId, recipients, authHeaders } = await createPendingViaApi(request, 2);
  const [first, second] = recipients;

  const apiRes = await request.post(`${baseUrl}/envelope/recipient/update-many`, {
    headers: authHeaders,
    data: { envelopeId, data: [{ id: first.id, email: second.email.toUpperCase() }] },
  });
  expect(apiRes.ok()).toBeFalsy();
  expect(await apiRes.text()).toContain(TAKEN_MESSAGE);

  const envelope = await prisma.envelope.findUniqueOrThrow({ where: { id: envelopeId }, include: { team: true } });
  const owner = await prisma.user.findUniqueOrThrow({ where: { id: envelope.userId } });

  await apiSignin({ page, email: owner.email, redirectPath: `/t/${envelope.team.url}/documents/${envelopeId}` });

  const editorRes = await page.context().request.post(`${webappUrl}/api/trpc/envelope.recipient.set`, {
    headers: { ...WEBAPP_ORIGIN_HEADERS, 'x-team-id': String(envelope.teamId) },
    data: {
      json: {
        envelopeId,
        envelopeType: 'DOCUMENT',
        recipients: [
          { id: first.id, email: second.email, name: first.name, role: first.role, signingOrder: first.signingOrder },
          {
            id: second.id,
            email: second.email,
            name: second.name,
            role: second.role,
            signingOrder: second.signingOrder,
          },
        ],
      },
    },
  });
  expect(editorRes.ok()).toBeFalsy();
  expect(await editorRes.text()).toContain(TAKEN_MESSAGE);

  const { user: admin } = await seedUser({ isAdmin: true });
  await apiSignin({ page, email: admin.email, redirectPath: '/admin' });

  const adminRes = await page.context().request.post(`${webappUrl}/api/trpc/admin.recipient.update`, {
    headers: WEBAPP_ORIGIN_HEADERS,
    data: { json: { id: first.id, name: first.name, email: second.email } },
  });
  expect(adminRes.ok()).toBeFalsy();
  expect(await adminRes.text()).toContain(TAKEN_MESSAGE);

  const firstAfter = await prisma.recipient.findUniqueOrThrow({ where: { id: first.id } });
  expect(firstAfter.email).toBe(first.email);
  expect(firstAfter.token).toBe(first.token);
});

test('[HANDOVER]: dictating an email another recipient already has is refused before anything is signed', async () => {
  const { user, team } = await seedUser();
  const [firstSigner, secondSigner] = [(await seedUser()).user, (await seedUser()).user];

  const { recipients } = await seedPendingDocumentWithFullFields({
    owner: user,
    teamId: team.id,
    recipients: [firstSigner, secondSigner],
    recipientsCreateOptions: [
      { signingOrder: 1, sendStatus: SendStatus.SENT },
      { signingOrder: 2, sendStatus: SendStatus.NOT_SENT },
    ],
    fields: [],
    updateDocumentOptions: {
      internalVersion: 2,
      documentMeta: {
        upsert: {
          create: { signingOrder: DocumentSigningOrder.SEQUENTIAL, allowDictateNextSigner: true },
          update: { signingOrder: DocumentSigningOrder.SEQUENTIAL, allowDictateNextSigner: true },
        },
      },
    },
  });

  const first = recipients.find((recipient) => recipient.email === firstSigner.email);
  const second = recipients.find((recipient) => recipient.email === secondSigner.email);

  if (!first || !second) {
    throw new Error('Seeded recipients are missing');
  }

  await expect(
    completeDocumentWithToken({
      token: first.token,
      id: { type: 'envelopeId', id: first.envelopeId },
      nextSigner: { name: 'Myself Again', email: first.email },
    }),
  ).rejects.toThrow(TAKEN_MESSAGE);

  expect((await prisma.recipient.findUniqueOrThrow({ where: { id: first.id } })).signingStatus).toBe('NOT_SIGNED');
  expect((await prisma.recipient.findUniqueOrThrow({ where: { id: second.id } })).email).toBe(second.email);
});

test('[HANDOVER][RT2-L2]: an admin edit of a signed recipient is refused with 400, not 500', async ({
  page,
  request,
}) => {
  const { recipients } = await createPendingViaApi(request);
  const [recipient] = recipients;

  await prisma.recipient.update({
    where: { id: recipient.id },
    data: { signingStatus: 'SIGNED', signedAt: new Date() },
  });

  const { user: admin } = await seedUser({ isAdmin: true });
  await apiSignin({ page, email: admin.email, redirectPath: '/admin' });

  const res = await page.context().request.post(`${webappUrl}/api/trpc/admin.recipient.update`, {
    headers: WEBAPP_ORIGIN_HEADERS,
    data: { json: { id: recipient.id, name: 'Too Late', email: uniqueEmail('too-late') } },
  });

  expect(res.status()).toBe(400);
  expect(await res.text()).toContain('Cannot update a recipient that has already signed.');
});

test('[HANDOVER][RT3-L2]: an admin edit of a recipient that does not exist answers 404', async ({ page }) => {
  const { user: admin } = await seedUser({ isAdmin: true });
  await apiSignin({ page, email: admin.email, redirectPath: '/admin' });

  const res = await page.context().request.post(`${webappUrl}/api/trpc/admin.recipient.update`, {
    headers: WEBAPP_ORIGIN_HEADERS,
    data: { json: { id: 2_000_000_000, name: 'Nobody', email: uniqueEmail('nobody') } },
  });

  expect(res.status()).toBe(404);
  const text = await res.text();
  expect(text).toContain('Recipient not found');
  expect(text).not.toContain('prisma');
});
