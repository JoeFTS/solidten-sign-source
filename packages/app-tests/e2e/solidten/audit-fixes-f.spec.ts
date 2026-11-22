import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { createApiToken } from '@documenso/lib/server-only/public-api/create-api-token';
import { mapSecondaryIdToDocumentId } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';
import { FieldType } from '@documenso/prisma/client';
import { seedPendingDocument, seedPendingDocumentWithFullFields } from '@documenso/prisma/seed/documents';
import { seedUser } from '@documenso/prisma/seed/users';
import type { APIRequestContext, Browser, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { apiSignin, WEBAPP_ORIGIN_HEADERS } from '../fixtures/authentication';
import { openDropdownMenu } from '../fixtures/generic';

/**
 * Solid Ten Sign, audit round F (suite follow-ups, 11/22).
 */

const trpcPost = async (request: APIRequestContext, path: string, json: unknown) =>
  await request.post(`${NEXT_PUBLIC_WEBAPP_URL()}/api/trpc/${path}`, {
    headers: { ...WEBAPP_ORIGIN_HEADERS, 'content-type': 'application/json' },
    data: JSON.stringify({ json }),
  });

const uniqueEmail = (label: string) =>
  `audit-f-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.documenso.com`;

/* -------------------------------------------------------------------------- */
/*   F1: the row menu is closed after a dialog opened from it closes          */
/* -------------------------------------------------------------------------- */

test.describe('F1: documents row menu', () => {
  const openRowMenu = async (page: Page, title: string) => {
    const actionButton = page.locator('tr', { hasText: title }).getByTestId('document-table-action-btn');
    await openDropdownMenu(page, actionButton);
  };

  const expectMenuClosed = async (page: Page) => {
    await expect(page.getByRole('menu')).toHaveCount(0);
  };

  test('dismissing or confirming "Cancel" leaves the row menu closed', async ({ page }) => {
    const sender = await seedUser({ setTeamEmailAsOwner: true });
    const recipient = await seedUser({ setTeamEmailAsOwner: true });

    await seedPendingDocument(sender.user, sender.team.id, [recipient.user], {
      createDocumentOptions: { title: 'Audit F row menu' },
    });

    await apiSignin({ page, email: sender.user.email, redirectPath: `/t/${sender.team.url}/documents` });

    // Dismiss.
    await openRowMenu(page, 'Audit F row menu');
    await page.getByRole('menuitem', { name: 'Cancel' }).click();
    await expect(page.getByRole('heading', { name: 'Are you sure?' })).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Are you sure?' })).toHaveCount(0);
    await expectMenuClosed(page);

    // Confirm.
    await openRowMenu(page, 'Audit F row menu');
    await page.getByRole('menuitem', { name: 'Cancel' }).click();
    await page.getByRole('button', { name: 'Cancel document' }).click();
    await expect(page.getByRole('heading', { name: 'Are you sure?' })).toHaveCount(0);
    await expectMenuClosed(page);

    // The page takes the next click: the status filter opens.
    await page.getByTestId('documents-table-status-filter').click();
    await expect(page.getByRole('option').first()).toBeVisible();
  });

  test('closing the duplicate and download dialogs leaves the row menu closed', async ({ page }) => {
    const sender = await seedUser({ setTeamEmailAsOwner: true });
    const recipient = await seedUser({ setTeamEmailAsOwner: true });

    await seedPendingDocument(sender.user, sender.team.id, [recipient.user], {
      createDocumentOptions: { title: 'Audit F other dialogs' },
    });

    await apiSignin({ page, email: sender.user.email, redirectPath: `/t/${sender.team.url}/documents` });

    for (const item of ['Duplicate', 'Download', 'Resend']) {
      await openRowMenu(page, 'Audit F other dialogs');
      await page.getByRole('menuitem', { name: item }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expectMenuClosed(page);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*   F3: reassign on an action-auth document needs the recipient's session    */
/* -------------------------------------------------------------------------- */

const seedReassignableActionAuthDocument = async () => {
  const { user: owner, team } = await seedUser();
  const { user: signerUser } = await seedUser();

  await prisma.teamGlobalSettings.update({
    where: { id: team.teamGlobalSettingsId },
    data: { allowSignerReassign: true },
  });

  const { recipients } = await seedPendingDocumentWithFullFields({
    owner,
    teamId: team.id,
    recipients: [signerUser],
    fields: [FieldType.SIGNATURE],
    updateDocumentOptions: {
      internalVersion: 2,
      authOptions: { globalAccessAuth: [], globalActionAuth: ['PASSWORD'] },
    },
  });

  return { recipient: recipients[0], signerUser };
};

const signedInDevice = async (browser: Browser, email: string) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await apiSignin({ page, email });

  return { context, request: context.request };
};

test.describe('F3: reassign on an action-auth document', () => {
  test('a signed-out holder of the link cannot pass the slot on', async ({ request }) => {
    const { recipient } = await seedReassignableActionAuthDocument();

    const res = await trpcPost(request, 'lifecycle.reassignRecipientWithToken', {
      token: recipient.token,
      name: 'Someone Else',
      email: uniqueEmail('taker'),
    });

    expect(res.status(), await res.text()).toBe(401);
    expect(await res.text()).toContain('Sign in as the recipient');

    const after = await prisma.recipient.findUniqueOrThrow({ where: { id: recipient.id } });
    expect(after.token).toBe(recipient.token);
    expect(after.email).toBe(recipient.email);
  });

  test('the recipient signed in with their own account still reassigns', async ({ browser }) => {
    const { recipient, signerUser } = await seedReassignableActionAuthDocument();
    const device = await signedInDevice(browser, signerUser.email);
    const newEmail = uniqueEmail('new');

    const res = await trpcPost(device.request, 'lifecycle.reassignRecipientWithToken', {
      token: recipient.token,
      name: 'New Person',
      email: newEmail,
    });

    expect(res.ok(), await res.text()).toBe(true);
    expect((await prisma.recipient.findUniqueOrThrow({ where: { id: recipient.id } })).email).toBe(newEmail);

    await device.context.close();
  });
});

/* -------------------------------------------------------------------------- */
/*   F4: API v1 resend to an unverified direct-link address answers 400       */
/* -------------------------------------------------------------------------- */

test('F4: API v1 resend to an unverified visitor address is a 400 with a clear message', async ({ request }) => {
  const { user, team } = await seedUser();
  const { user: visitor } = await seedUser();

  const document = await seedPendingDocument(user, team.id, [visitor]);
  const recipient = await prisma.recipient.findFirstOrThrow({ where: { envelopeId: document.id } });

  // The address a visitor typed on a direct link, not verified.
  await prisma.recipient.update({ where: { id: recipient.id }, data: { unverifiedEmailAt: new Date() } });

  const { token } = await createApiToken({ userId: user.id, teamId: team.id, tokenName: 'audit-f', expiresIn: null });

  const res = await request.post(
    `${NEXT_PUBLIC_WEBAPP_URL()}/api/v1/documents/${mapSecondaryIdToDocumentId(document.secondaryId)}/resend`,
    {
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      data: { recipients: [recipient.id] },
    },
  );

  const body = await res.text();

  expect(res.status(), body).toBe(400);
  expect(body).toContain('typed by a visitor on a direct link and is not verified');
  expect(body).not.toMatch(/change the/i);
});

/* -------------------------------------------------------------------------- */
/*   F5: GET /api/v1/me with a bad token answers 401                          */
/* -------------------------------------------------------------------------- */

test('F5: GET /api/v1/me answers 401 for a bad or missing token and 200 for a good one', async ({ request }) => {
  const bad = await request.get(`${NEXT_PUBLIC_WEBAPP_URL()}/api/v1/me`, {
    headers: { Authorization: 'Bearer api_not_a_real_token_audit_f' },
  });
  expect(bad.status(), await bad.text()).toBe(401);

  const missing = await request.get(`${NEXT_PUBLIC_WEBAPP_URL()}/api/v1/me`);
  expect(missing.status(), await missing.text()).toBe(401);

  const { user, team } = await seedUser();
  const { token } = await createApiToken({ userId: user.id, teamId: team.id, tokenName: 'audit-f', expiresIn: null });

  const good = await request.get(`${NEXT_PUBLIC_WEBAPP_URL()}/api/v1/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(good.status(), await good.text()).toBe(200);
  expect(((await good.json()) as { name: string }).name).toBe(team.name);
});
