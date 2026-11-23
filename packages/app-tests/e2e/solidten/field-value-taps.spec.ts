import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { mapSecondaryIdToTemplateId } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';
import { seedDirectTemplate } from '@documenso/prisma/seed/templates';
import { seedUser } from '@documenso/prisma/seed/users';
import { expect, test } from '@playwright/test';

import { addFieldValueSet, type TFieldKey, tapFieldValueSetV2 } from '../fixtures/field-value-set';

/**
 * Solid Ten Sign (L round 2, L1-A): by real taps, a version-2 direct link and a public form, each
 * with one required and one optional field of every type that has an optional setting (radio,
 * checkbox with "Select at least 2", dropdown, number, text) and the always-required email, name,
 * initials, date and signature. Every optional field is left untouched: the page sends "" for
 * them and the submission must go through, storing them as not filled.
 */

test.describe.configure({ mode: 'parallel', timeout: 240_000 });

const BASE = NEXT_PUBLIC_WEBAPP_URL();
const OPTIONAL: TFieldKey[] = ['radioOpt', 'cbOpt', 'dropdownOpt', 'numberOpt', 'textOpt'];

const sleep = async (ms: number) => await new Promise((resolve) => setTimeout(resolve, ms));

for (const [label, isPublicForm] of [
  ['direct link (version 2)', false],
  ['public form (version 2)', true],
] as const) {
  test(`${label}: optional fields left untouched, required ones filled by taps`, async ({ browser }) => {
    const { user, team } = await seedUser();
    const template = await seedDirectTemplate({
      title: `Taps ${label} ${Date.now()}`,
      userId: user.id,
      teamId: team.id,
      internalVersion: 2,
      createDirectRecipientSignatureField: false,
    });

    if (!template.directLink) {
      throw new Error('no direct link');
    }

    const ids = await addFieldValueSet(template.id, template.directLink.directTemplateRecipientId);

    if (isPublicForm) {
      await prisma.stPublicForm.create({ data: { directLinkId: template.directLink.id, requireVerifiedEmail: false } });
    }

    const context = await browser.newContext({ viewport: { width: 1280, height: 1100 } });
    // The test code runs through tsx, whose output calls __name() inside page.evaluate callbacks.
    await context.addInitScript('window.__name = window.__name || ((f) => f);');
    const page = await context.newPage();
    await page.setExtraHTTPHeaders({ 'x-forwarded-for': `198.51.100.${Math.floor(Math.random() * 200) + 20}` });

    const sent: { fieldId: number; value: string }[] = [];

    page.on('request', (request) => {
      if (request.url().includes('createDocumentFromDirectTemplate')) {
        const body = request.postDataJSON() as { 0?: { json?: { signedFieldValues?: typeof sent } } };
        sent.push(...(body[0]?.json?.signedFieldValues ?? []));
      }
    });

    await page.goto(`${BASE}/d/${template.directLink.token}`);
    const openedAt = Date.now();
    await page.locator('.konva-container canvas').first().waitFor({ timeout: 30_000 });
    await sleep(2_000);

    await tapFieldValueSetV2(page, ids, OPTIONAL);

    await expect(page.getByText('0 Fields Remaining').first()).toBeVisible();

    // A public form refuses a submission that comes too fast after opening.
    await sleep(Math.max(0, 7_500 - (Date.now() - openedAt)));

    const email = `taps-${Date.now()}@test.documenso.com`;
    await page.getByRole('button', { name: 'Complete' }).first().click();
    const dialog = page.getByRole('dialog').first();
    await dialog
      .getByPlaceholder(/your name/i)
      .fill('Sam Rivera')
      .catch(() => undefined);
    await dialog
      .getByPlaceholder(/your email/i)
      .fill(email)
      .catch(() => undefined);
    await dialog.getByRole('button', { name: 'Sign', exact: true }).click();

    await page.waitForURL(/\/complete/, { timeout: 60_000 });

    // The page sent "" for every untouched optional field (what the server must accept).
    for (const key of OPTIONAL) {
      expect(sent.find((value) => value.fieldId === ids[key])?.value, `${key} sent`).toBe('');
    }

    const document = await prisma.envelope.findFirstOrThrow({
      where: { templateId: mapSecondaryIdToTemplateId(template.secondaryId) },
      include: { fields: true },
    });

    // Optional fields: not filled. Required ones: filled.
    const insertedCount = document.fields.filter((field) => field.inserted).length;
    const notInsertedCount = document.fields.filter((field) => !field.inserted).length;

    expect(notInsertedCount).toBe(OPTIONAL.length);
    expect(insertedCount).toBe(15 - OPTIONAL.length);

    await context.close();
  });
}
