import { createHash, randomBytes } from 'node:crypto';
import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { AppError } from '@documenso/lib/errors/app-error';
import { createApiToken } from '@documenso/lib/server-only/public-api/create-api-token';
import { createDocumentFromTemplate } from '@documenso/lib/server-only/template/create-document-from-template';
import { mapSecondaryIdToDocumentId, mapSecondaryIdToTemplateId } from '@documenso/lib/utils/envelope';
import { formatDirectTemplatePath } from '@documenso/lib/utils/templates';
import { prisma } from '@documenso/prisma';
import { seedDirectTemplate } from '@documenso/prisma/seed/templates';
import { seedUser } from '@documenso/prisma/seed/users';
import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { FieldType, Prisma } from '@prisma/client';

import {
  apiCreateTestContext,
  apiSeedDraftDocument,
  apiSeedPendingDocument,
  apiSeedTemplate,
} from '../fixtures/api-seeds';
import { WEBAPP_ORIGIN_HEADERS } from '../fixtures/authentication';

/**
 * Solid Ten Sign, task O.
 * F1: one database check refuses every field change that takes the direct link signer's last
 * unconditional signature field away. F2/F5: one action-auth check on every create and update
 * path. F3/F4: plain refusals that name the field. F6: /check-email with password sign-in off.
 *
 * F2, F5 and F6 need a server with NEXT_PUBLIC_DISABLE_EMAIL_PASSWORD_SIGNIN=true (read from the page).
 */

const BASE = NEXT_PUBLIC_WEBAPP_URL();
const V2 = `${BASE}/api/v2-beta`;
const PLAIN_F1 = 'The direct link signer needs at least one signature field without a condition.';
const ID_IN_TEXT = /\b(Field|Recipient|field|recipient) \d+|id: \d+/;

test.describe.configure({ mode: 'parallel' });

const messageOf = async (response: { text: () => Promise<string> }) => {
  const text = await response.text();

  try {
    const body = JSON.parse(text) as { message?: string; error?: { json?: { message?: string } } };

    return body.error?.json?.message ?? body.message ?? text;
  } catch {
    return text;
  }
};

const trpc = async (request: APIRequestContext, path: string, json: unknown, teamId?: number) =>
  await request.post(`${BASE}/api/trpc/${path}`, {
    headers: {
      ...WEBAPP_ORIGIN_HEADERS,
      'content-type': 'application/json',
      ...(teamId ? { 'x-team-id': String(teamId) } : {}),
    },
    data: JSON.stringify({ json }),
  });

const signInByEmailLink = async (page: Page, userId: number) => {
  const token = randomBytes(32).toString('hex');

  await prisma.verificationToken.create({
    data: {
      identifier: 'email-link-signin',
      token: createHash('sha256').update(token).digest('hex'),
      expires: new Date(Date.now() + 15 * 60 * 1000),
      userId,
    },
  });

  const response = await page.context().request.post(`${BASE}/api/auth/email-link/authorize`, {
    headers: { ...WEBAPP_ORIGIN_HEADERS, 'content-type': 'application/json' },
    data: JSON.stringify({ token }),
  });

  expect(response.ok(), await response.text()).toBe(true);
};

const isPasswordSigninOff = async (page: Page) => {
  await page.goto(`${BASE}/signin`);

  return await page.evaluate(
    () =>
      (window as { __ENV__?: Record<string, string | undefined> }).__ENV__
        ?.NEXT_PUBLIC_DISABLE_EMAIL_PASSWORD_SIGNIN === 'true',
  );
};

const setCfr21 = async (teamId: number, cfr21: boolean) => {
  const { organisation } = await prisma.team.findUniqueOrThrow({
    where: { id: teamId },
    select: { organisation: { select: { organisationClaimId: true } } },
  });
  const claim = await prisma.organisationClaim.findUniqueOrThrow({ where: { id: organisation.organisationClaimId } });

  await prisma.organisationClaim.update({
    where: { id: claim.id },
    data: { flags: { ...(claim.flags as Record<string, unknown>), cfr21 } },
  });
};

/* -------------------------------------------------------------------------- */
/*                                     F1                                     */
/* -------------------------------------------------------------------------- */

const seedLinkTemplate = async () => {
  const { user, team } = await seedUser();
  const template = await seedDirectTemplate({
    title: `Task O ${Date.now()}`,
    userId: user.id,
    teamId: team.id,
    internalVersion: 2,
  });

  if (!template.directLink) {
    throw new Error('no direct link');
  }

  const signature = await prisma.field.findFirstOrThrow({
    where: { envelopeId: template.id, type: FieldType.SIGNATURE },
  });
  const item = await prisma.envelopeItem.findFirstOrThrow({ where: { envelopeId: template.id } });
  const company = await prisma.field.create({
    data: {
      envelopeId: template.id,
      envelopeItemId: item.id,
      recipientId: template.directLink.directTemplateRecipientId,
      type: FieldType.TEXT,
      page: 1,
      positionX: new Prisma.Decimal(10),
      positionY: new Prisma.Decimal(30),
      width: new Prisma.Decimal(20),
      height: new Prisma.Decimal(5),
      customText: '',
      inserted: false,
      fieldMeta: { type: 'text', label: 'Company', fieldKey: 'company' },
    },
  });
  const { token } = await createApiToken({ userId: user.id, teamId: team.id, tokenName: 'o-f1', expiresIn: null });

  return { user, team, template, directLink: template.directLink, signature, company, token };
};

const fieldStillThere = async (id: number) => (await prisma.field.count({ where: { id } })) === 1;

test.describe('F1: every field mutation path keeps the direct link usable', () => {
  test('API v2 field/delete is refused with the plain message', async ({ request }) => {
    const { signature, token } = await seedLinkTemplate();

    const response = await request.post(`${V2}/envelope/field/delete`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { fieldId: signature.id },
    });

    expect(response.status()).toBe(400);
    expect(await messageOf(response)).toContain(PLAIN_F1);
    expect(await fieldStillThere(signature.id)).toBe(true);
  });

  test('web envelope.field.delete is refused', async ({ page }) => {
    const { user, team, signature } = await seedLinkTemplate();

    await signInByEmailLink(page, user.id);
    const response = await trpc(page.context().request, 'envelope.field.delete', { fieldId: signature.id }, team.id);

    expect(response.ok()).toBe(false);
    const message = await messageOf(response);
    expect(message).toContain(PLAIN_F1);
    expect(message).not.toContain('ST_DIRECT_LINK');
    expect(await fieldStillThere(signature.id)).toBe(true);
  });

  test('API v2 field/update-many adding a condition is refused', async ({ request }) => {
    const { template, signature, token } = await seedLinkTemplate();

    const response = await request.post(`${V2}/envelope/field/update-many`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        envelopeId: template.id,
        data: [
          {
            id: signature.id,
            type: FieldType.SIGNATURE,
            fieldMeta: { type: 'signature', condition: { fieldKey: 'company', operator: 'notEmpty' } },
          },
        ],
      },
    });

    expect(response.status()).toBe(400);
    expect(await messageOf(response)).toContain(PLAIN_F1);
  });

  test('a delete that leaves another unconditional signature field is allowed; so is removing the link first', async ({
    request,
  }) => {
    const { template, directLink, signature, token } = await seedLinkTemplate();
    const second = await prisma.field.create({
      data: {
        envelopeId: signature.envelopeId,
        envelopeItemId: signature.envelopeItemId,
        recipientId: signature.recipientId,
        type: FieldType.SIGNATURE,
        page: 1,
        positionX: new Prisma.Decimal(10),
        positionY: new Prisma.Decimal(60),
        width: new Prisma.Decimal(20),
        height: new Prisma.Decimal(5),
        customText: '',
        inserted: false,
      },
    });

    const first = await request.post(`${V2}/envelope/field/delete`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { fieldId: signature.id },
    });
    expect(first.ok(), await first.text()).toBe(true);

    await prisma.templateDirectLink.update({ where: { id: directLink.id }, data: { enabled: false } });
    const last = await request.post(`${V2}/envelope/field/delete`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { fieldId: second.id },
    });
    expect(last.ok(), await last.text()).toBe(true);
    expect(await prisma.field.count({ where: { envelopeId: template.id, type: FieldType.SIGNATURE } })).toBe(0);
  });

  test('a template that is already faulty can still be edited (other fields)', async ({ request }) => {
    const { company, signature, directLink, token } = await seedLinkTemplate();
    const hide = { fieldMeta: { type: 'signature', condition: { fieldKey: 'company', operator: 'notEmpty' } } };

    // Even a straight database update is refused (the check is in the database)...
    const direct = await prisma.field.update({ where: { id: signature.id }, data: hide }).then(
      () => null,
      (err: Error) => AppError.parseError(err).message,
    );
    expect(direct).toContain(PLAIN_F1);

    // ...so the fault is made the old way: link off, condition on, link on again.
    await prisma.templateDirectLink.update({ where: { id: directLink.id }, data: { enabled: false } });
    await prisma.field.update({ where: { id: signature.id }, data: hide });
    await prisma.templateDirectLink.update({ where: { id: directLink.id }, data: { enabled: true } });

    const response = await request.post(`${V2}/envelope/field/delete`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { fieldId: company.id },
    });
    expect(response.ok(), await response.text()).toBe(true);
  });

  test('deleting the whole template still works', async ({ request }) => {
    const { template, token } = await seedLinkTemplate();

    const response = await request.post(`${V2}/envelope/delete`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { envelopeId: template.id },
    });

    expect(response.ok(), await response.text()).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*                                   F2, F5                                   */
/* -------------------------------------------------------------------------- */

const PASSWORD_REFUSED = '"Require password" cannot be used on this server';
const TEMPLATE_PASSWORD_REFUSED = 'This template uses "Require password"';

test.describe('F2/F5: the one action-auth check on every path (password sign-in off)', () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!(await isPasswordSigninOff(page)), 'needs a server with NEXT_PUBLIC_DISABLE_EMAIL_PASSWORD_SIGNIN=true');
  });

  const seedV1Template = async (request: APIRequestContext) => {
    const context = await apiCreateTestContext('o-f2');
    const { envelope } = await apiSeedTemplate(request, {
      context,
      recipients: [{ email: 'o-f2-signer@example.com', name: 'Sam Rivera', role: 'SIGNER' }],
    });
    const recipient = await prisma.recipient.findFirstOrThrow({ where: { envelopeId: envelope.id } });

    return { context, template: envelope, recipient, templateId: mapSecondaryIdToTemplateId(envelope.secondaryId) };
  };

  const generate = async (
    request: APIRequestContext,
    token: string,
    templateId: number,
    recipientId: number,
    authOptions?: unknown,
  ) =>
    await request.post(`${BASE}/api/v1/templates/${templateId}/generate-document`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        recipients: [{ id: recipientId, email: `o-f2-${Date.now()}@example.com`, name: 'Sam Rivera' }],
        ...(authOptions ? { authOptions } : {}),
      },
    });

  test('API v1 generate-document: PASSWORD refused 400 (plan on) and 401 (plan off); nothing made', async ({
    request,
  }) => {
    const { context, templateId, recipient } = await seedV1Template(request);
    const before = await prisma.envelope.count({ where: { teamId: context.team.id, type: 'DOCUMENT' } });

    await setCfr21(context.team.id, true);
    const refused = await generate(request, context.token, templateId, recipient.id, {
      globalActionAuth: ['PASSWORD'],
    });
    expect(refused.status()).toBe(400);
    expect(await messageOf(refused)).toContain(PASSWORD_REFUSED);

    await setCfr21(context.team.id, false);
    const noPlan = await generate(request, context.token, templateId, recipient.id, {
      globalActionAuth: ['TWO_FACTOR_AUTH'],
    });
    expect(noPlan.status()).toBe(401);
    expect(await messageOf(noPlan)).toContain('You do not have permission to set the action auth');

    expect(await prisma.envelope.count({ where: { teamId: context.team.id, type: 'DOCUMENT' } })).toBe(before);
  });

  test('a template that has PASSWORD: v1 generate, v2 use, the bulk/Use Template function and the direct link refuse it', async ({
    request,
    browser,
  }) => {
    const { context, template, templateId, recipient } = await seedV1Template(request);
    await prisma.envelope.update({
      where: { id: template.id },
      data: { authOptions: { globalAccessAuth: [], globalActionAuth: ['PASSWORD'] } },
    });

    const v1 = await generate(request, context.token, templateId, recipient.id);
    expect(v1.status()).toBe(400);
    expect(await messageOf(v1)).toContain(TEMPLATE_PASSWORD_REFUSED);

    const v2 = await request.post(`${V2}/template/use`, {
      headers: { Authorization: `Bearer ${context.token}` },
      data: { templateId, recipients: [{ id: recipient.id, email: 'o-f2-use@example.com', name: 'Sam Rivera' }] },
    });
    expect(v2.status()).toBe(400);
    expect(await messageOf(v2)).toContain(TEMPLATE_PASSWORD_REFUSED);

    // Bulk send and the web "Use Template" call this function for each document. It runs in this
    // test process here, so it reads the switch from this process.
    const savedSwitch = process.env.NEXT_PUBLIC_DISABLE_EMAIL_PASSWORD_SIGNIN;
    process.env.NEXT_PUBLIC_DISABLE_EMAIL_PASSWORD_SIGNIN = 'true';
    const direct = await createDocumentFromTemplate({
      id: { type: 'templateId', id: templateId },
      userId: context.user.id,
      teamId: context.team.id,
      recipients: [{ id: recipient.id, email: 'o-f2-bulk@example.com', name: 'Sam Rivera' }],
      requestMetadata: { requestMetadata: {}, source: 'app', auth: null },
    }).then(
      () => null,
      (err) => AppError.parseError(err),
    );
    process.env.NEXT_PUBLIC_DISABLE_EMAIL_PASSWORD_SIGNIN = savedSwitch;
    expect(direct?.message).toContain(TEMPLATE_PASSWORD_REFUSED);

    // A direct link on a template with a recipient-level PASSWORD: the visitor reads the plain page.
    const { user, team } = await seedUser();
    const linked = await seedDirectTemplate({
      title: 'O-F2 link',
      userId: user.id,
      teamId: team.id,
      internalVersion: 2,
    });
    await prisma.recipient.update({
      where: { id: linked.directLink!.directTemplateRecipientId },
      data: { authOptions: { accessAuth: [], actionAuth: ['PASSWORD'] } },
    });
    const visitor = await browser.newContext();
    const visitorPage = await visitor.newPage();
    await visitorPage.goto(formatDirectTemplatePath(linked.directLink!.token));
    await expect(visitorPage.getByText('This form is not set up correctly. Contact the sender.')).toBeVisible();
    await visitor.close();
  });

  test('API v1 recipient create with PASSWORD: 400 with the reason (F5), not the 500 catch-all', async ({
    request,
  }) => {
    const context = await apiCreateTestContext('o-f5');
    await setCfr21(context.team.id, true);
    const { envelope } = await apiSeedDraftDocument(request, {
      context,
      recipients: [{ email: `o-f5-${Date.now()}@example.com`, name: 'Sam Rivera' }],
    });
    const documentId = mapSecondaryIdToDocumentId(
      (await prisma.envelope.findUniqueOrThrow({ where: { id: envelope.id } })).secondaryId,
    );

    const response = await request.post(`${BASE}/api/v1/documents/${documentId}/recipients`, {
      headers: { Authorization: `Bearer ${context.token}` },
      data: { name: 'Jordan Lee', email: 'jordan@example.com', authOptions: { actionAuth: ['PASSWORD'] } },
    });

    expect(response.status()).toBe(400);
    expect(await messageOf(response)).toContain(PASSWORD_REFUSED);
    expect(await prisma.recipient.count({ where: { envelopeId: envelope.id, email: 'jordan@example.com' } })).toBe(0);
  });

  test('API v2 create: PASSWORD refused 400 with the plan, 401 without; duplicate of a PASSWORD document refused', async ({
    request,
  }) => {
    const context = await apiCreateTestContext('o-f2-v2');
    await setCfr21(context.team.id, true);

    const create = async () =>
      await apiSeedDraftDocument(request, {
        context,
        recipients: [
          { email: `o-f2v2-${Date.now()}@example.com`, name: 'Sam Rivera', actionAuth: ['PASSWORD'] } as never,
        ],
      }).then(
        () => null,
        (err: Error) => err.message,
      );

    expect(await create()).toContain('cannot be used on this server: password sign-in is turned off');

    await setCfr21(context.team.id, false);
    expect(await create()).toContain('You do not have permission to set the action auth');

    const { envelope } = await apiSeedDraftDocument(request, {
      context,
      recipients: [{ email: `o-f2dup-${Date.now()}@example.com`, name: 'Sam Rivera' }],
    });
    await prisma.envelope.update({
      where: { id: envelope.id },
      data: { authOptions: { globalAccessAuth: [], globalActionAuth: ['PASSWORD'] } },
    });
    const duplicate = await request.post(`${V2}/envelope/duplicate`, {
      headers: { Authorization: `Bearer ${context.token}` },
      data: { envelopeId: envelope.id },
    });
    expect(duplicate.status()).toBe(400);
    expect(await messageOf(duplicate)).toContain('This document uses "Require password"');
  });

  test('without the plan, a stored PASSWORD can be taken off (F7) and kept unchanged', async ({ request }) => {
    const context = await apiCreateTestContext('o-f7');
    const { envelope } = await apiSeedDraftDocument(request, {
      context,
      recipients: [{ email: `o-f7-${Date.now()}@example.com`, name: 'Sam Rivera' }],
    });
    const recipient = await prisma.recipient.findFirstOrThrow({ where: { envelopeId: envelope.id } });
    await prisma.recipient.update({
      where: { id: recipient.id },
      data: { authOptions: { accessAuth: [], actionAuth: ['PASSWORD'] } },
    });
    await setCfr21(context.team.id, false);

    const update = async (actionAuth: string[]) =>
      await request.post(`${V2}/envelope/recipient/update-many`, {
        headers: { Authorization: `Bearer ${context.token}` },
        data: { envelopeId: envelope.id, data: [{ id: recipient.id, actionAuth }] },
      });

    expect((await update(['PASSWORD'])).ok()).toBe(true);
    expect((await update([])).ok()).toBe(true);
    const stored = await prisma.recipient.findUniqueOrThrow({ where: { id: recipient.id } });
    expect(JSON.stringify(stored.authOptions)).not.toContain('PASSWORD');
  });
});

/* -------------------------------------------------------------------------- */
/*                                   F3, F4                                   */
/* -------------------------------------------------------------------------- */

test('F3: the distribute refusal names no ids', async ({ request }) => {
  const context = await apiCreateTestContext('o-f3');
  const { envelope } = await apiSeedDraftDocument(request, {
    context,
    recipients: [{ email: `o-f3-${Date.now()}@example.com`, name: 'Sam Rivera' }],
  });

  const response = await request.post(`${V2}/envelope/distribute`, {
    headers: { Authorization: `Bearer ${context.token}` },
    data: { envelopeId: envelope.id },
  });

  expect(response.status()).toBe(400);
  const message = await messageOf(response);
  expect(message).toContain('Sam Rivera');
  expect(message).not.toMatch(ID_IN_TEXT);
});

test('F4: value refusals name the field; a completed document gets its true reason', async ({ request }) => {
  const { envelope } = await apiSeedPendingDocument(request, {
    recipients: [{ email: `o-f4-${Date.now()}@example.com`, name: 'Sam Rivera' }],
    fieldsPerRecipient: [
      [
        { type: FieldType.SIGNATURE, page: 1, positionX: 60, positionY: 5, width: 20, height: 5 },
        {
          type: FieldType.EMAIL,
          page: 1,
          positionX: 10,
          positionY: 30,
          width: 30,
          height: 5,
          fieldMeta: { type: 'email', label: 'Work email' },
        },
        {
          type: FieldType.RADIO,
          page: 1,
          positionX: 10,
          positionY: 50,
          width: 30,
          height: 5,
          fieldMeta: { type: 'radio', label: 'Meal', values: [{ id: 1, checked: false, value: 'Lunch' }] },
        },
      ],
    ],
  });
  const recipient = await prisma.recipient.findFirstOrThrow({ where: { envelopeId: envelope.id } });
  const emailField = await prisma.field.findFirstOrThrow({ where: { envelopeId: envelope.id, type: FieldType.EMAIL } });
  const radioField = await prisma.field.findFirstOrThrow({ where: { envelopeId: envelope.id, type: FieldType.RADIO } });

  // The send fills the signer's own address in; empty it, as for a field the signer must type.
  await prisma.field.update({ where: { id: emailField.id }, data: { inserted: false, customText: '' } });

  const sign = async (fieldId: number, fieldValue: unknown) =>
    await trpc(request, 'envelope.field.sign', { token: recipient.token, fieldId, fieldValue });

  const badEmail = await messageOf(await sign(emailField.id, { type: FieldType.EMAIL, value: 'not-an-address' }));
  expect(badEmail).toMatch(/^The "Work email" field on page 1 /);

  const badRadio = await messageOf(await sign(radioField.id, { type: FieldType.RADIO, value: 7 }));
  expect(badRadio).toMatch(/^The "Meal" field on page 1 /);

  // V1 route, same rules.
  const v1Email = await messageOf(
    await trpc(request, 'field.signFieldWithToken', {
      token: recipient.token,
      fieldId: emailField.id,
      value: 'not-an-address',
      isBase64: false,
    }),
  );
  expect(v1Email).toMatch(/^The "Work email" field on page 1 /);

  // A field of a completed document: the true reason, whatever value is sent.
  await prisma.envelope.update({ where: { id: envelope.id }, data: { status: 'COMPLETED', completedAt: new Date() } });
  const completed = await messageOf(await sign(radioField.id, { type: FieldType.TEXT, value: 'x' }));
  expect(completed).toBe('This document can no longer be signed.');

  for (const message of [badEmail, badRadio, v1Email, completed]) {
    expect(message).not.toMatch(ID_IN_TEXT);
  }
});

/* -------------------------------------------------------------------------- */
/*                                   F6, F7                                   */
/* -------------------------------------------------------------------------- */

test('F6: /check-email sends a signed-out visitor to sign-in when password sign-in is off', async ({ page }) => {
  test.skip(!(await isPasswordSigninOff(page)), 'needs a server with NEXT_PUBLIC_DISABLE_EMAIL_PASSWORD_SIGNIN=true');

  await page.goto(`${BASE}/check-email`);
  await expect(page).toHaveURL(/\/signin(\?|$)/);
});

test('F8: API v1 PATCH of a recipient that is not on the document is a 404', async ({ request }) => {
  const context = await apiCreateTestContext('o-f8');
  const { envelope } = await apiSeedDraftDocument(request, {
    context,
    recipients: [{ email: `o-f8-${Date.now()}@example.com`, name: 'Sam Rivera' }],
  });
  const documentId = mapSecondaryIdToDocumentId(
    (await prisma.envelope.findUniqueOrThrow({ where: { id: envelope.id } })).secondaryId,
  );

  const response = await request.patch(`${BASE}/api/v1/documents/${documentId}/recipients/999999999`, {
    headers: { Authorization: `Bearer ${context.token}` },
    data: { name: 'Jordan Lee', email: 'jordan@example.com' },
  });

  expect(response.status()).toBe(404);
  expect(await messageOf(response)).toBe('Recipient not found');
});
