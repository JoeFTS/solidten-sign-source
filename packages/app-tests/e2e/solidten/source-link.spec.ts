import { DEFAULT_SOURCE_CODE_URL, NEXT_PUBLIC_ST_SOURCE_URL } from '@documenso/lib/constants/source-code';
import { formatDirectTemplatePath } from '@documenso/lib/utils/templates';
import { prisma } from '@documenso/prisma';
import { seedCompletedDocument, seedPendingDocument } from '@documenso/prisma/seed/documents';
import { seedDirectTemplate } from '@documenso/prisma/seed/templates';
import { seedUser } from '@documenso/prisma/seed/users';
import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { apiSignin } from '../fixtures/authentication';

/**
 * Solid Ten Sign (AGPL-3.0 section 13): every user of the service can find the source code.
 */

test.describe.configure({ mode: 'parallel' });

const SOURCE_URL = NEXT_PUBLIC_ST_SOURCE_URL();

const uniqueEmail = (label: string) =>
  `source-link-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.documenso.com`;

const expectSourceLink = async (page: Page) => {
  const link = page.getByTestId('source-code-link').first();

  await expect(link).toBeVisible({ timeout: 30_000 });
  await expect(link).toHaveAttribute('href', SOURCE_URL);
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(page.getByTestId('source-code-notice').first()).toContainText(
    'Solid Ten Sign is open source (AGPL-3.0).',
  );
};

test('the URL is the configured one or the default', () => {
  expect(SOURCE_URL).toMatch(/^https?:\/\//);

  if (!process.env.NEXT_PUBLIC_ST_SOURCE_URL) {
    expect(SOURCE_URL).toBe(DEFAULT_SOURCE_CODE_URL);
  }
});

test('the sign-in page shows the source link', async ({ page }) => {
  await page.goto('/signin');

  await expectSourceLink(page);
});

test('a signing page (V1 and V2) shows the source link', async ({ page }) => {
  const { user, team } = await seedUser();

  for (const internalVersion of [1, 2] as const) {
    const document = await seedPendingDocument(user, team.id, [uniqueEmail(`v${internalVersion}`)], {
      internalVersion,
    });
    const recipient = await prisma.recipient.findFirstOrThrow({ where: { envelopeId: document.id } });

    await page.goto(`/sign/${recipient.token}`);

    await expectSourceLink(page);
  }
});

test('the completed page shows the source link', async ({ page }) => {
  const { user, team } = await seedUser();

  const document = await seedCompletedDocument(user, team.id, [uniqueEmail('done')], {
    internalVersion: 2,
    createDocumentOptions: { completedAt: new Date() },
  });
  const recipient = await prisma.recipient.findFirstOrThrow({ where: { envelopeId: document.id } });

  await page.goto(`/sign/${recipient.token}/complete`);

  await expectSourceLink(page);
});

test('the account menu of the signed-in app has the source link', async ({ page }) => {
  const { user, team } = await seedUser();

  await apiSignin({ page, email: user.email, redirectPath: `/t/${team.url}/documents` });

  await page.getByTestId('menu-switcher').click();

  const link = page.getByTestId('menu-source-code-link');
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', SOURCE_URL);
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
});

/* -------------------------------------------------------------------------- */
/*   H-D1: the link really takes a tap at phone width                         */
/* -------------------------------------------------------------------------- */

/** True when the element at the centre of the locator's box is the locator itself (or inside it). */
const isOnTop = async (testIdOrRole: ReturnType<Page['getByTestId']>) => {
  const box = await testIdOrRole.boundingBox();

  if (!box) {
    return false;
  }

  return await testIdOrRole.evaluate(
    (element, point) => {
      const top = document.elementFromPoint(point.x, point.y);

      return top !== null && (element === top || element.contains(top));
    },
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  );
};

/** Scroll to the link, tap it, and expect a new tab at the source URL (served locally, no network). */
const tapSourceLink = async (page: Page) => {
  await page
    .context()
    .route(`${SOURCE_URL}**`, async (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<p>source</p>' }),
    );

  const link = page.getByTestId('source-code-link').last();
  await expect(link).toBeVisible({ timeout: 30_000 });
  await link.scrollIntoViewIfNeeded();

  expect(await isOnTop(link)).toBe(true);

  // No force: a covered link fails here, as it did in H-D1.
  const [popup] = await Promise.all([page.context().waitForEvent('page'), link.click({ timeout: 5_000 })]);
  await popup.waitForLoadState();

  expect(popup.url()).toBe(SOURCE_URL);
  await popup.close();
};

test.describe('H-D1: phone width (390 px)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('V1 signing page: a tap opens the source; the sign panel is not covered', async ({ page }) => {
    const { user, team } = await seedUser();
    const document = await seedPendingDocument(user, team.id, [uniqueEmail('phone-v1')], { internalVersion: 1 });
    const recipient = await prisma.recipient.findFirstOrThrow({ where: { envelopeId: document.id } });

    await page.goto(`/sign/${recipient.token}`);

    await tapSourceLink(page);

    // The fixed sign panel still lies on top of everything at the bottom of the page.
    const panelTitle = page.getByText('Sign Document', { exact: true }).last();
    await expect(panelTitle).toBeVisible();
    expect(await isOnTop(panelTitle)).toBe(true);

    const complete = page.getByRole('button', { name: 'Complete' }).last();
    await expect(complete).toBeVisible();
    expect(await isOnTop(complete)).toBe(true);
    await page.screenshot({ path: test.info().outputPath('v1-390-bottom.png') });
  });

  test('completed page: a tap opens the source', async ({ page }) => {
    const { user, team } = await seedUser();
    const document = await seedCompletedDocument(user, team.id, [uniqueEmail('phone-done')], {
      internalVersion: 2,
      createDocumentOptions: { completedAt: new Date() },
    });
    const recipient = await prisma.recipient.findFirstOrThrow({ where: { envelopeId: document.id } });

    await page.goto(`/sign/${recipient.token}/complete`);

    await tapSourceLink(page);
  });

  test('rejected page: a tap opens the source', async ({ page }) => {
    const { user, team } = await seedUser();
    const document = await seedPendingDocument(user, team.id, [uniqueEmail('phone-rejected')], {
      internalVersion: 2,
    });
    const recipient = await prisma.recipient.findFirstOrThrow({ where: { envelopeId: document.id } });

    await prisma.recipient.update({
      where: { id: recipient.id },
      data: { signingStatus: 'REJECTED', rejectionReason: 'Not for me' },
    });
    await prisma.envelope.update({ where: { id: document.id }, data: { status: 'REJECTED' } });

    await page.goto(`/sign/${recipient.token}/rejected`);
    await expect(page).toHaveURL(/\/rejected$/);

    await tapSourceLink(page);
  });

  test('direct-link page: a tap opens the source', async ({ page }) => {
    const { user, team } = await seedUser();
    const template = await seedDirectTemplate({ title: '[TEST] Source link direct', userId: user.id, teamId: team.id });

    await page.goto(formatDirectTemplatePath(template.directLink?.token ?? ''));

    await tapSourceLink(page);
  });
});
