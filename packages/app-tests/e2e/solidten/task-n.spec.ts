import { createHash, randomBytes } from 'node:crypto';
import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { AppError } from '@documenso/lib/errors/app-error';
import { updateEnvelopeFields } from '@documenso/lib/server-only/field/update-envelope-fields';
import { DOCUMENT_AUDIT_LOG_TYPE } from '@documenso/lib/types/document-audit-logs';
import { mapSecondaryIdToDocumentId, mapSecondaryIdToTemplateId } from '@documenso/lib/utils/envelope';
import { formatDirectTemplatePath } from '@documenso/lib/utils/templates';
import { prisma } from '@documenso/prisma';
import { seedDirectTemplate } from '@documenso/prisma/seed/templates';
import { seedUser } from '@documenso/prisma/seed/users';
import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { FieldType, Prisma } from '@prisma/client';
import { apiCreateTestContext, apiSeedDraftDocument, apiSeedPendingDocument } from '../fixtures/api-seeds';
import { WEBAPP_ORIGIN_HEADERS } from '../fixtures/authentication';
import { runWithoutDbChecks } from '../fixtures/without-db-checks';

/**
 * Solid Ten Sign, task N.
 * N-1 a direct link whose signer has only conditional signature fields, N-3 refusals without
 * internal ids, N-4 a tap does not clear a field the app filled, N-5 "Require password" with
 * password sign-in off (run once against a server with the switch on and once with it off).
 * N-6 a cancellation email stopped by the email limit (needs DANGEROUS_BYPASS_RATE_LIMITS off).
 */

const BASE = NEXT_PUBLIC_WEBAPP_URL();
const PLACEHOLDER = 'direct.link@solidten.io';
const ID_IN_TEXT = /\b(Field|Recipient|field|recipient) \d+/;

test.describe.configure({ mode: 'parallel' });

const trpc = async (request: APIRequestContext, path: string, json: unknown, meta?: unknown, teamId?: number) =>
  await request.post(`${BASE}/api/trpc/${path}`, {
    headers: {
      ...WEBAPP_ORIGIN_HEADERS,
      'content-type': 'application/json',
      ...(teamId ? { 'x-team-id': String(teamId) } : {}),
    },
    data: JSON.stringify(meta ? { json, meta } : { json }),
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

const addField = async (
  envelopeId: string,
  recipientId: number,
  type: FieldType,
  positionY: number,
  fieldMeta: Record<string, unknown> | null,
  extra: Partial<Prisma.FieldUncheckedCreateInput> = {},
) => {
  const item = await prisma.envelopeItem.findFirstOrThrow({ where: { envelopeId } });

  return await prisma.field.create({
    data: {
      envelopeId,
      envelopeItemId: item.id,
      recipientId,
      type,
      page: 1,
      positionX: new Prisma.Decimal(10),
      positionY: new Prisma.Decimal(positionY),
      width: new Prisma.Decimal(20),
      height: new Prisma.Decimal(5),
      customText: '',
      inserted: false,
      ...(fieldMeta ? { fieldMeta: fieldMeta as Prisma.InputJsonValue } : {}),
      ...extra,
    },
  });
};

/** A V2 template with a direct link that is on, a "Company" text field and the signer's signature field. */
const seedLinkTemplate = async () => {
  const { user, team } = await seedUser();
  const template = await seedDirectTemplate({
    title: `Task N ${Date.now()}`,
    userId: user.id,
    teamId: team.id,
    internalVersion: 2,
  });

  if (!template.directLink) {
    throw new Error('no direct link');
  }

  const recipientId = template.directLink.directTemplateRecipientId;
  const signature = await prisma.field.findFirstOrThrow({
    where: { envelopeId: template.id, type: FieldType.SIGNATURE },
  });
  const company = await addField(template.id, recipientId, FieldType.TEXT, 30, {
    type: 'text',
    label: 'Company',
    fieldKey: 'company',
  });

  return { user, team, template, directLink: template.directLink, signature, company };
};

const CONDITION = { condition: { fieldKey: 'company', operator: 'notEmpty' } };

/* -------------------------------------------------------------------------- */
/*                                     N-1                                    */
/* -------------------------------------------------------------------------- */

test.describe('N-1: a direct link whose signer has only conditional signature fields', () => {
  test('the editor refuses the save that would break a link that is on', async () => {
    const { user, team, template, signature } = await seedLinkTemplate();

    const error = await updateEnvelopeFields({
      userId: user.id,
      teamId: team.id,
      id: { type: 'envelopeId', id: template.id },
      fields: [{ id: signature.id, fieldMeta: { type: 'signature', ...CONDITION } as never }],
      requestMetadata: { requestMetadata: {}, source: 'app', auth: null },
    }).then(
      () => null,
      // O-F1: the database refuses it; the app answers with the plain message.
      (err: Error) => AppError.parseError(err),
    );

    expect(error?.message).toContain('The direct link signer needs at least one signature field without a condition.');
    expect(error?.message).toContain('This template has a direct link that is on');
    expect(error?.message).not.toContain(PLACEHOLDER);

    const stored = await prisma.field.findUniqueOrThrow({ where: { id: signature.id } });
    expect((stored.fieldMeta as { condition?: unknown } | null)?.condition).toBeUndefined();
  });

  test('turning on a link with this fault is refused, with no placeholder address', async ({ page }) => {
    const { user, team, template, directLink, signature } = await seedLinkTemplate();

    // O-F1: the database refuses the condition while the link is on, so the link goes off first.
    await prisma.templateDirectLink.update({ where: { id: directLink.id }, data: { enabled: false } });
    await prisma.field.update({
      where: { id: signature.id },
      data: { fieldMeta: { type: 'signature', ...CONDITION } },
    });

    await signInByEmailLink(page, user.id);
    const response = await trpc(
      page.context().request,
      'template.toggleTemplateDirectLink',
      { templateId: mapSecondaryIdToTemplateId(template.secondaryId), enabled: true },
      undefined,
      team.id,
    );
    const text = await response.text();

    expect(response.ok()).toBe(false);
    expect(text).toContain('The direct link signer needs at least one signature field without a condition.');
    expect(text).not.toContain(PLACEHOLDER);
    expect((await prisma.templateDirectLink.findUniqueOrThrow({ where: { id: directLink.id } })).enabled).toBe(false);
  });

  test('an existing link with the fault: the visitor reads one plain line, the owner sees it', async ({
    page,
    browser,
  }) => {
    const { user, team, template, directLink, signature, company } = await seedLinkTemplate();

    // The fault made before this fix (an old save could; O-F1 now refuses it while the link is
    // on, so: link off, condition on, link on again).
    await prisma.templateDirectLink.update({ where: { id: directLink.id }, data: { enabled: false } });
    await prisma.field.update({
      where: { id: signature.id },
      data: { fieldMeta: { type: 'signature', ...CONDITION } },
    });
    // Q-1 refuses turning a faulty link on, so it is turned on with the checks off.
    await runWithoutDbChecks('UPDATE "TemplateDirectLink" SET "enabled" = true WHERE "id" = $1', [directLink.id]);

    // The visitor opens the link: a plain page up front, not "0 Fields Remaining".
    const visitor = await browser.newContext();
    const visitorPage = await visitor.newPage();
    await visitorPage.goto(formatDirectTemplatePath(directLink.token));
    await expect(visitorPage.getByText('This form is not set up correctly. Contact the sender.')).toBeVisible();
    expect(await visitorPage.locator('body').innerText()).not.toContain(PLACEHOLDER);

    // A submission sent anyway gets the same plain message, and the template gets an entry.
    const { updatedAt } = await prisma.envelope.findUniqueOrThrow({ where: { id: template.id } });
    const submit = await trpc(
      visitor.request,
      'template.createDocumentFromDirectTemplate',
      {
        directTemplateToken: directLink.token,
        directRecipientEmail: `visitor-${Date.now()}@example.com`,
        directRecipientName: 'Sam Rivera',
        templateUpdatedAt: updatedAt.toISOString(),
        signedFieldValues: [
          { token: '', fieldId: company.id, value: 'Northside Bakery', isBase64: false },
          { token: '', fieldId: signature.id, value: 'Sam Rivera', isBase64: false },
        ],
      },
      { values: { templateUpdatedAt: ['Date'] } },
    );
    const submitText = await submit.text();
    await visitor.close();

    expect(submit.ok()).toBe(false);
    expect(submitText).toContain('This form is not set up correctly. Contact the sender.');
    expect(submitText).not.toContain(PLACEHOLDER);
    expect(
      await prisma.documentAuditLog.count({
        where: { envelopeId: template.id, type: DOCUMENT_AUDIT_LOG_TYPE.DIRECT_LINK_SUBMISSION_REFUSED },
      }),
    ).toBe(1);

    // The owner sees it on the template page.
    await signInByEmailLink(page, user.id);
    await page.goto(`${BASE}/t/${team.url}/templates/${template.id}`);
    await expect(page.getByTestId('direct-link-broken-alert')).toBeVisible();
    await expect(page.getByText('Visitors cannot submit this direct link')).toBeVisible();
  });
});

/* -------------------------------------------------------------------------- */
/*                                     N-3                                    */
/* -------------------------------------------------------------------------- */

const messageOf = (text: string) =>
  (JSON.parse(text) as { error?: { json?: { message?: string } } }).error?.json?.message ?? text;

test('N-3: signing refusals name no internal ids', async ({ request }) => {
  const { envelope } = await apiSeedPendingDocument(request, {
    recipients: [{ email: `n3-${Date.now()}@example.com`, name: 'Sam Rivera' }],
  });
  const recipient = await prisma.recipient.findFirstOrThrow({ where: { envelopeId: envelope.id } });
  const readOnly = await addField(envelope.id, recipient.id, FieldType.TEXT, 60, {
    type: 'text',
    label: 'Venue',
    readOnly: true,
    text: 'Main Hall',
  });

  const sign = await trpc(request, 'envelope.field.sign', {
    token: recipient.token,
    fieldId: readOnly.id,
    fieldValue: { type: FieldType.TEXT, value: 'Other' },
  });
  expect(sign.ok()).toBe(false);
  const readOnlyMessage = messageOf(await sign.text());
  expect(readOnlyMessage).toBe('The "Venue" field on page 1 is read-only.');

  const missing = await trpc(request, 'envelope.field.sign', {
    token: recipient.token,
    fieldId: 999_999_999,
    fieldValue: { type: FieldType.TEXT, value: 'x' },
  });
  expect(missing.ok()).toBe(false);
  const missingMessage = messageOf(await missing.text());

  const complete = await trpc(request, 'recipient.completeDocumentWithToken', {
    token: recipient.token,
    documentId: mapSecondaryIdToDocumentId(
      (await prisma.envelope.findUniqueOrThrow({ where: { id: envelope.id } })).secondaryId,
    ),
  });
  expect(complete.ok()).toBe(false);
  const completeMessage = messageOf(await complete.text());
  expect(completeMessage).toBe('Fill in every required field before you finish.');

  for (const message of [readOnlyMessage, missingMessage, completeMessage]) {
    expect(message).not.toMatch(ID_IN_TEXT);
  }
});

/* -------------------------------------------------------------------------- */
/*                                     N-4                                    */
/* -------------------------------------------------------------------------- */

test('N-4: a tap on the email field the app filled does not clear it', async ({ page, request }) => {
  const email = `n4-${Date.now()}@example.com`;
  const emailBox = { page: 1, positionX: 10, positionY: 40, width: 30, height: 6 };

  // The real path: the send fills the signer's own address into the EMAIL field.
  const { envelope } = await apiSeedPendingDocument(request, {
    recipients: [{ email, name: 'Sam Rivera' }],
    fieldsPerRecipient: [
      [
        { type: FieldType.SIGNATURE, page: 1, positionX: 60, positionY: 5, width: 20, height: 5 },
        { type: FieldType.EMAIL, ...emailBox },
      ],
    ],
  });
  const recipient = await prisma.recipient.findFirstOrThrow({ where: { envelopeId: envelope.id } });
  const emailField = await prisma.field.findFirstOrThrow({ where: { envelopeId: envelope.id, type: FieldType.EMAIL } });
  expect([emailField.inserted, emailField.customText]).toEqual([true, email]);

  await page.goto(`${BASE}/sign/${recipient.token}`);
  const canvas = page.locator('.konva-container canvas').first();
  await expect(canvas).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(3000);

  const box = await canvas.boundingBox();
  if (!box) {
    throw new Error('no canvas box');
  }

  const tap = async () =>
    await canvas.click({
      position: {
        x: ((emailBox.positionX + emailBox.width / 2) / 100) * box.width,
        y: ((emailBox.positionY + emailBox.height / 2) / 100) * box.height,
      },
    });

  await tap();
  await expect(page.getByText('This field is filled in for you with your email address.').first()).toBeVisible();

  // A second tap (the tester's scripts tapped twice) does not clear it either.
  await page.waitForTimeout(1000);
  await tap();
  await page.waitForTimeout(2000);

  const stored = await prisma.field.findUniqueOrThrow({ where: { id: emailField.id } });
  expect([stored.inserted, stored.customText]).toEqual([true, email]);
  // Only the signature is left; the email field still counts as filled.
  await expect(page.getByText('1 Field Remaining').first()).toBeVisible();
});

/* -------------------------------------------------------------------------- */
/*                                     N-5                                    */
/* -------------------------------------------------------------------------- */

const isPasswordSigninOff = async (page: Page) => {
  await page.goto(`${BASE}/signin`);

  return await page.evaluate(
    () =>
      (window as { __ENV__?: Record<string, string | undefined> }).__ENV__
        ?.NEXT_PUBLIC_DISABLE_EMAIL_PASSWORD_SIGNIN === 'true',
  );
};

/** A draft V2 document with one signer, by the API, in a team whose plan allows action auth (cfr21). */
const seedApiDraft = async (request: APIRequestContext) => {
  const context = await apiCreateTestContext('n5');
  const { organisation } = await prisma.team.findUniqueOrThrow({
    where: { id: context.team.id },
    select: { organisation: { select: { organisationClaimId: true } } },
  });
  const claim = await prisma.organisationClaim.findUniqueOrThrow({ where: { id: organisation.organisationClaimId } });
  await prisma.organisationClaim.update({
    where: { id: claim.id },
    data: { flags: { ...(claim.flags as Record<string, unknown>), cfr21: true } },
  });

  const { envelope } = await apiSeedDraftDocument(request, {
    context,
    recipients: [{ email: `n5-${Date.now()}@example.com`, name: 'Sam Rivera' }],
  });
  const recipient = await prisma.recipient.findFirstOrThrow({ where: { envelopeId: envelope.id } });

  const updateRecipient = async (actionAuth: string[]) =>
    await request.post(`${BASE}/api/v2-beta/envelope/recipient/update-many`, {
      headers: { Authorization: `Bearer ${context.token}` },
      data: { envelopeId: envelope.id, data: [{ id: recipient.id, actionAuth }] },
    });

  return { recipient, updateRecipient };
};

test.describe('N-5: "Require password" with password sign-in off', () => {
  test('refused with a 400 and a plain reason; a document that has it keeps it', async ({ page, request }) => {
    test.skip(!(await isPasswordSigninOff(page)), 'needs a server with NEXT_PUBLIC_DISABLE_EMAIL_PASSWORD_SIGNIN=true');

    const { recipient, updateRecipient } = await seedApiDraft(request);

    const refused = await updateRecipient(['PASSWORD']);
    expect(refused.status()).toBe(400);
    expect(((await refused.json()) as { message: string }).message).toContain(
      '"Require password" cannot be used on this server',
    );

    const stored = await prisma.recipient.findUniqueOrThrow({ where: { id: recipient.id } });
    expect(JSON.stringify(stored.authOptions)).not.toContain('PASSWORD');

    // A recipient that already has it (set before the switch went off) may be saved unchanged,
    // and the option can be taken off.
    await prisma.recipient.update({
      where: { id: recipient.id },
      data: { authOptions: { accessAuth: [], actionAuth: ['PASSWORD'] } },
    });
    expect((await updateRecipient(['PASSWORD'])).ok()).toBe(true);
    expect((await updateRecipient([])).ok()).toBe(true);
  });

  test('with password sign-in on, "Require password" is still accepted', async ({ page, request }) => {
    test.skip(await isPasswordSigninOff(page), 'needs a server with password sign-in on');

    const { updateRecipient } = await seedApiDraft(request);

    const accepted = await updateRecipient(['PASSWORD']);
    expect(accepted.ok(), await accepted.text()).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*                                     N-6                                    */
/* -------------------------------------------------------------------------- */

test.describe('N-6: a cancellation email stopped by the email limit', () => {
  test.skip(
    process.env.DANGEROUS_BYPASS_RATE_LIMITS === 'true',
    'needs DANGEROUS_BYPASS_RATE_LIMITS off on the app and the tests (it turns the limit off)',
  );

  test('gets an audit entry; no notice email is queued', async ({ request }) => {
    const context = await apiCreateTestContext('n6-limit');
    const signerEmail = `n6-limit-${Date.now()}@example.com`;

    const { envelope } = await apiSeedPendingDocument(request, {
      context,
      recipients: [{ email: signerEmail, name: 'Sam Rivera' }],
      fieldsPerRecipient: [[{ type: FieldType.SIGNATURE, page: 1, positionX: 60, positionY: 5, width: 20, height: 5 }]],
    });

    const recipient = await prisma.recipient.findFirstOrThrow({ where: { envelopeId: envelope.id } });
    await expect
      .poll(async () => (await prisma.recipient.findUniqueOrThrow({ where: { id: recipient.id } })).sendStatus, {
        timeout: 60_000,
      })
      .toBe('SENT');

    // The limit is reached after the signing request went out.
    const { organisation } = await prisma.team.findUniqueOrThrow({
      where: { id: context.team.id },
      select: { organisation: { select: { organisationClaimId: true } } },
    });
    await prisma.organisationClaim.update({ where: { id: organisation.organisationClaimId }, data: { emailQuota: 0 } });

    const cancel = await request.post(`${BASE}/api/v2-beta/envelope/cancel`, {
      headers: { Authorization: `Bearer ${context.token}` },
      data: { envelopeId: envelope.id, reason: 'Wrong date' },
    });
    expect(cancel.ok(), await cancel.text()).toBe(true);

    await expect
      .poll(
        async () =>
          (
            await prisma.documentAuditLog.findMany({
              where: { envelopeId: envelope.id, type: 'EMAIL_NOT_DELIVERED' },
            })
          ).map((entry) => entry.data as { emailType?: string; reason?: string; recipientId?: number }),
        { timeout: 60_000 },
      )
      .toContainEqual(
        expect.objectContaining({ emailType: 'DOCUMENT_CANCELLED', reason: 'LIMIT', recipientId: recipient.id }),
      );

    const notices = await prisma.backgroundJob.count({
      where: { jobId: 'send.solidten.notice.email', payload: { path: ['envelopeId'], equals: envelope.id } },
    });
    expect(notices).toBe(0);
  });
});
