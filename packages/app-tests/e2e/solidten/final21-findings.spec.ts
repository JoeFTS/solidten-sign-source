import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { prisma } from '@documenso/prisma';
import { DocumentStatus, EnvelopeType, FieldType, Prisma } from '@documenso/prisma/client';
import { seedCompletedDocument, seedPendingDocument } from '@documenso/prisma/seed/documents';
import { seedUser } from '@documenso/prisma/seed/users';
import type { TUseEnvelopePayload } from '@documenso/trpc/server/envelope-router/use-envelope.types';
import { expect, test } from '@playwright/test';

import { apiSeedTemplate } from '../fixtures/api-seeds';
import { WEBAPP_ORIGIN_HEADERS } from '../fixtures/authentication';

/**
 * Solid Ten Sign, findings from final21 (task J).
 * A-1: no "email copy" promise to a recipient who gets none. A-2: a refused "use template and
 * send" leaves no draft. A-3: a value the field refuses is a 400, not a 500.
 */

test.describe.configure({ mode: 'parallel' });

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();

const uniqueEmail = (label: string) =>
  `final21-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.documenso.com`;

/* -------------------------------------------------------------------------- */
/*   A-1                                                                      */
/* -------------------------------------------------------------------------- */

test.describe('A-1: the completed page promises an email copy only when one is sent', () => {
  const seedCompleted = async ({ isUnverified }: { isUnverified: boolean }) => {
    const { user, team } = await seedUser();
    const document = await seedCompletedDocument(user, team.id, [uniqueEmail('done')], {
      internalVersion: 2,
      createDocumentOptions: { completedAt: new Date() },
    });
    const recipient = await prisma.recipient.findFirstOrThrow({ where: { envelopeId: document.id } });

    if (isUnverified) {
      await prisma.recipient.update({ where: { id: recipient.id }, data: { unverifiedEmailAt: new Date() } });
    }

    return recipient;
  };

  test('a visitor whose email was not checked: "not sent by email" and a Download button', async ({ page }) => {
    const recipient = await seedCompleted({ isUnverified: true });

    await page.goto(`/sign/${recipient.token}/complete`);

    await expect(page.getByText('Your copy is not sent by email. Download it here.')).toBeVisible();
    await expect(page.getByText('You will receive an email copy')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Download' })).toBeVisible();
  });

  test('a normal recipient still reads that the copy comes by email (control)', async ({ page }) => {
    const recipient = await seedCompleted({ isUnverified: false });

    await page.goto(`/sign/${recipient.token}/complete`);

    await expect(
      page.getByText(/Everyone has signed! (You will receive an email copy|Download your signed copy)/),
    ).toBeVisible();
    await expect(page.getByText('Your copy is not sent by email')).toHaveCount(0);
  });
});

/* -------------------------------------------------------------------------- */
/*   A-2                                                                      */
/* -------------------------------------------------------------------------- */

test('A-2: "use template" with send, refused, leaves no draft behind', async ({ request }) => {
  const {
    envelope: template,
    token,
    team,
  } = await apiSeedTemplate(request, {
    recipients: [{ email: uniqueEmail('signer'), name: 'Signer' }],
    fieldsPerRecipient: [
      [
        { type: FieldType.SIGNATURE, page: 1, positionX: 60, positionY: 5, width: 20, height: 5 },
        {
          type: FieldType.NUMBER,
          page: 1,
          positionX: 5,
          positionY: 25,
          width: 25,
          height: 5,
          fieldMeta: { type: 'number', label: 'Total', formula: '{{price}} * {{qty}}' },
        },
      ],
    ],
  });

  const documentsOfTeam = async () =>
    await prisma.envelope.count({ where: { teamId: team.id, type: EnvelopeType.DOCUMENT } });

  expect(await documentsOfTeam()).toBe(0);

  const payload: TUseEnvelopePayload = { envelopeId: template.id, distributeDocument: true };
  const formData = new FormData();
  formData.append('payload', JSON.stringify(payload));

  const res = await request.post(`${WEBAPP_BASE_URL}/api/v2-beta/envelope/use`, {
    headers: { Authorization: `Bearer ${token}` },
    multipart: formData,
  });

  expect(res.status()).toBe(400);
  expect(((await res.json()) as { message: string }).message).toContain(
    'uses the field key "price", but no field has that key',
  );

  // The refused send left nothing behind (before: a DRAFT document).
  expect(await documentsOfTeam()).toBe(0);
});

/* -------------------------------------------------------------------------- */
/*   A-3                                                                      */
/* -------------------------------------------------------------------------- */

test('A-3: a text value over the character limit is a 400 with the reason, not a 500', async ({ request }) => {
  const { user, team } = await seedUser();
  const document = await seedPendingDocument(user, team.id, [uniqueEmail('limit')], { internalVersion: 1 });
  const recipient = await prisma.recipient.findFirstOrThrow({ where: { envelopeId: document.id } });
  const item = await prisma.envelopeItem.findFirstOrThrow({ where: { envelopeId: document.id } });

  const field = await prisma.field.create({
    data: {
      envelopeId: document.id,
      envelopeItemId: item.id,
      recipientId: recipient.id,
      type: FieldType.TEXT,
      page: 1,
      positionX: new Prisma.Decimal(10),
      positionY: new Prisma.Decimal(10),
      width: new Prisma.Decimal(20),
      height: new Prisma.Decimal(5),
      customText: '',
      inserted: false,
      fieldMeta: { type: 'text', characterLimit: 10 },
    },
  });

  const sign = async (value: string) =>
    await request.post(`${WEBAPP_BASE_URL}/api/trpc/field.signFieldWithToken`, {
      headers: { ...WEBAPP_ORIGIN_HEADERS, 'content-type': 'application/json' },
      data: JSON.stringify({ json: { token: recipient.token, fieldId: field.id, value, isBase64: false } }),
    });

  const refused = await sign('12345678901');
  expect(refused.status()).toBe(400);
  expect(await refused.text()).toContain('exceeds the character limit');
  expect((await prisma.field.findUniqueOrThrow({ where: { id: field.id } })).inserted).toBe(false);

  const accepted = await sign('1234567890');
  expect(accepted.ok()).toBe(true);
  expect((await prisma.field.findUniqueOrThrow({ where: { id: field.id } })).customText).toBe('1234567890');

  expect((await prisma.envelope.findUniqueOrThrow({ where: { id: document.id } })).status).toBe(DocumentStatus.PENDING);
});
