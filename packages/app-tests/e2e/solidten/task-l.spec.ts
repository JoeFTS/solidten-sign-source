import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { prisma } from '@documenso/prisma';
import { FieldType, Prisma } from '@documenso/prisma/client';
import { seedPendingDocument } from '@documenso/prisma/seed/documents';
import { seedUser } from '@documenso/prisma/seed/users';
import type { APIRequestContext } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { apiSignin, WEBAPP_ORIGIN_HEADERS } from '../fixtures/authentication';

/**
 * Solid Ten Sign, task L. Version-1 signing (field.signFieldWithToken) takes only values the
 * field allows (L-1) and refuses a second fill plainly (L-2).
 */

test.describe.configure({ mode: 'parallel' });

const uniqueEmail = (label: string) =>
  `task-l-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.documenso.com`;

const seedV1 = async () => {
  const { user, team } = await seedUser();
  const document = await seedPendingDocument(user, team.id, [uniqueEmail('signer')], { internalVersion: 1 });
  const recipient = await prisma.recipient.findFirstOrThrow({ where: { envelopeId: document.id } });
  const item = await prisma.envelopeItem.findFirstOrThrow({ where: { envelopeId: document.id } });

  const addField = async (type: FieldType, fieldMeta: Prisma.InputJsonValue | undefined, positionY: number) =>
    await prisma.field.create({
      data: {
        envelopeId: document.id,
        envelopeItemId: item.id,
        recipientId: recipient.id,
        type,
        page: 1,
        positionX: new Prisma.Decimal(10),
        positionY: new Prisma.Decimal(positionY),
        width: new Prisma.Decimal(20),
        height: new Prisma.Decimal(4),
        customText: '',
        inserted: false,
        // biome-ignore lint/suspicious/noExplicitAny: the test stores raw meta, as an old client may.
        fieldMeta: fieldMeta as any,
      },
    });

  return { document, recipient, addField };
};

const sign = async (request: APIRequestContext, token: string, fieldId: number, value: string) =>
  await request.post(`${NEXT_PUBLIC_WEBAPP_URL()}/api/trpc/field.signFieldWithToken`, {
    headers: { ...WEBAPP_ORIGIN_HEADERS, 'content-type': 'application/json' },
    data: JSON.stringify({ json: { token, fieldId, value, isBase64: false } }),
  });

const message = async (response: Awaited<ReturnType<typeof sign>>) =>
  ((await response.json()) as { error?: { json?: { message?: string } } }).error?.json?.message ?? '';

test('L-1: radio takes only its options; "Maybe" for Yes/No is a 400 and nothing is stored', async ({ request }) => {
  const { recipient, addField } = await seedV1();
  const field = await addField(
    FieldType.RADIO,
    {
      type: 'radio',
      values: [
        { id: 1, checked: false, value: 'Yes' },
        { id: 2, checked: false, value: 'No' },
      ],
    },
    10,
  );

  const refused = await sign(request, recipient.token, field.id, 'Maybe');
  expect(refused.status()).toBe(400);
  expect(await message(refused)).toMatch(/^The .+ field on page 1 has a value that is not one of its options\./);
  expect((await prisma.field.findUniqueOrThrow({ where: { id: field.id } })).inserted).toBe(false);

  const accepted = await sign(request, recipient.token, field.id, 'Yes');
  expect(accepted.ok()).toBe(true);
  expect((await prisma.field.findUniqueOrThrow({ where: { id: field.id } })).customText).toBe('Yes');

  // L-2: a second fill is a plain 400, not a 500.
  const again = await sign(request, recipient.token, field.id, 'No');
  expect(again.status()).toBe(400);
  expect(await message(again)).toBe('This field is already filled in. Clear it first to change it.');
});

test('L-1: checkbox, dropdown, number, text, email and name refuse what V2 refuses', async ({ request }) => {
  const { recipient, addField } = await seedV1();

  const cases: Array<{ type: FieldType; meta?: Prisma.InputJsonValue; bad: string; good: string; reason: RegExp }> = [
    {
      type: FieldType.CHECKBOX,
      meta: {
        type: 'checkbox',
        values: [
          { id: 1, checked: false, value: 'A' },
          { id: 2, checked: false, value: 'B' },
        ],
      },
      bad: '["A","Z"]',
      good: '["A"]',
      reason: /^The .+ field on page 1 has (a|a chosen) value that is not one of its options/,
    },
    {
      type: FieldType.DROPDOWN,
      meta: { type: 'dropdown', values: [{ value: 'Red' }, { value: 'Blue' }] },
      bad: 'Green',
      good: 'Blue',
      reason: /^The .+ field on page 1 has (a|a chosen) value that is not one of its options/,
    },
    {
      type: FieldType.NUMBER,
      meta: { type: 'number', minValue: 1, maxValue: 10 },
      bad: '50',
      good: '7',
      reason: /10/,
    },
    {
      type: FieldType.TEXT,
      meta: { type: 'text', characterLimit: 5 },
      bad: 'too long text',
      good: 'short',
      reason: /character limit/,
    },
    {
      type: FieldType.EMAIL,
      meta: { type: 'email' },
      bad: 'not an email',
      good: 'a@example.com',
      reason: /valid email/,
    },
    { type: FieldType.NAME, meta: { type: 'name' }, bad: '   ', good: 'Ada Lovelace', reason: /required/ },
  ];

  let positionY = 10;

  for (const testCase of cases) {
    positionY += 6;
    const field = await addField(testCase.type, testCase.meta, positionY);

    const refused = await sign(request, recipient.token, field.id, testCase.bad);
    expect(refused.status(), `${testCase.type} "${testCase.bad}"`).toBe(400);
    expect(await message(refused)).toMatch(testCase.reason);
    expect((await prisma.field.findUniqueOrThrow({ where: { id: field.id } })).inserted).toBe(false);

    const accepted = await sign(request, recipient.token, field.id, testCase.good);
    expect(accepted.ok(), `${testCase.type} "${testCase.good}": ${await accepted.text()}`).toBe(true);
  }
});

test('L-1: a field of another document is a 404, not a 500', async ({ request }) => {
  const first = await seedV1();
  const second = await seedV1();
  const otherField = await second.addField(FieldType.TEXT, { type: 'text' }, 10);

  const response = await sign(request, first.recipient.token, otherField.id, 'hello');
  expect(response.status()).toBe(404);
  expect((await prisma.field.findUniqueOrThrow({ where: { id: otherField.id } })).inserted).toBe(false);
});

test('L-4: a recipient stopped by the email limit gets the limit text in the "Not delivered" box', async ({ page }) => {
  const { user, team } = await seedUser();
  const document = await seedPendingDocument(user, team.id, [uniqueEmail('limit')], { internalVersion: 2 });
  const recipient = await prisma.recipient.findFirstOrThrow({ where: { envelopeId: document.id } });

  await prisma.recipient.update({
    where: { id: recipient.id },
    data: { sendStatus: 'NOT_SENT', deliveryFailedAt: new Date() },
  });
  await prisma.documentAuditLog.create({
    data: {
      envelopeId: document.id,
      type: 'EMAIL_NOT_DELIVERED',
      data: {
        recipientId: recipient.id,
        recipientEmail: recipient.email,
        recipientName: recipient.name,
        recipientRole: recipient.role,
        emailType: 'SIGNING_REQUEST',
        attempts: 1,
        reason: 'LIMIT',
      },
    },
  });

  await apiSignin({ page, email: user.email, redirectPath: `/t/${team.url}/documents/${document.id}` });

  const badge = page.getByTestId(`recipient-not-delivered-${recipient.id}`);
  await expect(badge).toBeVisible({ timeout: 30_000 });
  await badge.hover();
  await expect(page.getByTestId(`recipient-not-delivered-limit-${recipient.id}`)).toContainText(
    "The organization's email limit was reached",
  );
  await expect(page.getByText('Check the email address, then send it again.')).toHaveCount(0);
});
