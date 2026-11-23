import { createHash, randomBytes } from 'node:crypto';
import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { prisma } from '@documenso/prisma';
import { seedUser } from '@documenso/prisma/seed/users';
import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { WEBAPP_ORIGIN_HEADERS } from '../fixtures/authentication';

/**
 * Solid Ten Sign, task M: with password sign-in off (NEXT_PUBLIC_DISABLE_EMAIL_PASSWORD_SIGNIN=true)
 * no page offers a password action. Run this file twice: once against a server with the switch
 * on, once with it off. Each test reads the switch from the page (window.__ENV__), so the
 * runner's own environment does not matter.
 */

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();

/** Signs the page in by emailed link (works with the switch on and off). */
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

  const response = await page.context().request.post(`${WEBAPP_BASE_URL}/api/auth/email-link/authorize`, {
    headers: { ...WEBAPP_ORIGIN_HEADERS, 'content-type': 'application/json' },
    data: JSON.stringify({ token }),
  });

  expect(response.ok(), await response.text()).toBe(true);
};

const isPasswordSigninOff = async (page: Page) => {
  await page.goto(`${WEBAPP_BASE_URL}/signin`);

  return await page.evaluate(() => {
    const env = (window as { __ENV__?: Record<string, string | undefined> }).__ENV__ ?? {};

    return env.NEXT_PUBLIC_DISABLE_EMAIL_PASSWORD_SIGNIN === 'true';
  });
};

const MAIL_SINK_URL = process.env.E2E_MAIL_SINK_URL;

/** The plain text of the first mail to `to` in the mail sink (Mailpit), waiting up to 45 s. */
const waitForMailText = async (to: string) => {
  const deadline = Date.now() + 45_000;

  while (Date.now() < deadline) {
    const res = await fetch(`${MAIL_SINK_URL}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
    const body = (await res.json()) as { messages?: { ID: string }[] };
    const first = body.messages?.[0];

    if (first) {
      const message = (await (await fetch(`${MAIL_SINK_URL}/api/v1/message/${first.ID}`)).json()) as { Text: string };

      return message.Text;
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(`no mail to ${to}`);
};

const postAuth = async (page: Page, path: string, body: unknown) =>
  await page.context().request.post(`${WEBAPP_BASE_URL}/api/auth/email-password/${path}`, {
    headers: { ...WEBAPP_ORIGIN_HEADERS, 'content-type': 'application/json' },
    data: JSON.stringify(body),
  });

test.describe('M: password sign-in ON', () => {
  test.beforeEach(async ({ page }) => {
    test.skip(await isPasswordSigninOff(page), 'needs a server with password sign-in on');
  });

  test('the Security page shows "Update password" to a user with a password', async ({ page }) => {
    const { user } = await seedUser();

    await signInByEmailLink(page, user.id);
    await page.goto(`${WEBAPP_BASE_URL}/settings/security`);

    await expect(page.getByRole('button', { name: 'Update password' })).toBeVisible();
    await expect(page.getByTestId('password-signin-off-note')).toHaveCount(0);
  });

  test('the Security page offers "Set a password" to a user without one', async ({ page }) => {
    const { user } = await seedUser();
    await prisma.user.update({ where: { id: user.id }, data: { password: null } });

    await signInByEmailLink(page, user.id);
    await page.goto(`${WEBAPP_BASE_URL}/settings/security`);

    await expect(page.getByText('Set a password', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Update password' })).toHaveCount(0);
  });

  test('the sign-in page has "Forgot your password?" and the page opens', async ({ page }) => {
    await page.goto(`${WEBAPP_BASE_URL}/signin`);
    await expect(page.getByRole('link', { name: 'Forgot your password?' })).toBeVisible();

    await page.goto(`${WEBAPP_BASE_URL}/forgot-password`);
    await expect(page).toHaveURL(/\/forgot-password$/);
  });
});

test.describe('M: password sign-in OFF', () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!(await isPasswordSigninOff(page)), 'needs a server with NEXT_PUBLIC_DISABLE_EMAIL_PASSWORD_SIGNIN=true');
  });

  test('the Security page has no password section, only the one-line note', async ({ page }) => {
    // seedUser gives the user a password hash, as on the production accounts that showed the form.
    const { user } = await seedUser();

    await signInByEmailLink(page, user.id);
    await page.goto(`${WEBAPP_BASE_URL}/settings/security`);

    await expect(page.getByTestId('password-signin-off-note')).toHaveText(
      'This server signs you in with a link we email you. There is no password to set or change.',
    );
    await expect(page.getByRole('button', { name: 'Update password' })).toHaveCount(0);
    await expect(page.getByLabel('Current Password')).toHaveCount(0);
    await expect(page.getByText('Set a password', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Here you can manage your security settings.')).toBeVisible();

    // The rest of the page stays.
    await expect(page.getByText('Two factor authentication', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Manage passkeys' })).toBeVisible();
  });

  test('a user without a password sees the same note and no "Set a password"', async ({ page }) => {
    const { user } = await seedUser();
    await prisma.user.update({ where: { id: user.id }, data: { password: null } });

    await signInByEmailLink(page, user.id);
    await page.goto(`${WEBAPP_BASE_URL}/settings/security`);

    await expect(page.getByTestId('password-signin-off-note')).toBeVisible();
    await expect(page.getByText('Set a password', { exact: true })).toHaveCount(0);
  });

  test('the sign-in page has no password link; the password pages send you to sign-in', async ({ page }) => {
    await page.goto(`${WEBAPP_BASE_URL}/signin`);
    await expect(page.getByRole('link', { name: 'Forgot your password?' })).toHaveCount(0);

    for (const path of ['/forgot-password', '/reset-password', '/reset-password/not-a-real-token']) {
      await page.goto(`${WEBAPP_BASE_URL}${path}`);
      await expect(page, path).toHaveURL(/\/signin(\?|$)/);
    }
  });

  test('the server routes make no reset token and set no password', async ({ page }) => {
    const { user } = await seedUser();
    await prisma.user.update({ where: { id: user.id }, data: { password: null } });

    const forgot = await postAuth(page, 'forgot-password', { email: user.email });
    expect(forgot.ok()).toBe(false);
    expect(await forgot.text()).toContain('SIGNIN_DISABLED');
    expect(await prisma.passwordResetToken.count({ where: { userId: user.id } })).toBe(0);

    // A token made some other way (for example before the switch went off) cannot be redeemed.
    const token = randomBytes(18).toString('hex');
    await prisma.passwordResetToken.create({
      data: { token, userId: user.id, expiry: new Date(Date.now() + 60 * 60 * 1000) },
    });

    const reset = await postAuth(page, 'reset-password', { token, password: 'A-new-password-1234' });
    expect(reset.ok()).toBe(false);
    expect(await reset.text()).toContain('SIGNIN_DISABLED');

    // A signed-in session cannot set one either.
    await signInByEmailLink(page, user.id);
    const update = await postAuth(page, 'update-password', {
      currentPassword: 'whatever-1234',
      password: 'A-new-password-1234',
    });
    expect(update.ok()).toBe(false);
    expect(await update.text()).toContain('SIGNIN_DISABLED');

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.password).toBeNull();

    // And no password login works.
    const authorize = await page.context().request.post(`${WEBAPP_BASE_URL}/api/auth/email-password/authorize`, {
      headers: { ...WEBAPP_ORIGIN_HEADERS, 'content-type': 'application/json' },
      data: JSON.stringify({ email: user.email, password: 'A-new-password-1234' }),
    });
    expect(authorize.ok()).toBe(false);
  });

  test('e-mail sign-up is closed: the sign-up route refuses and makes no account', async ({ page }) => {
    const email = `task-m-${randomBytes(4).toString('hex')}@example.com`;

    const signup = await postAuth(page, 'signup', { name: 'Task M', email, password: 'A-new-password-1234' });
    expect(signup.ok()).toBe(false);
    expect(await signup.text()).toContain('SIGNUP_DISABLED');
    expect(await prisma.user.count({ where: { email } })).toBe(0);
  });

  test('admin "Create User": the dialog and the welcome email point to emailed-link sign-in', async ({ page }) => {
    test.skip(!MAIL_SINK_URL, 'E2E_MAIL_SINK_URL is not set');

    const { user: admin } = await seedUser({ isAdmin: true });
    const email = `task-m-new-${randomBytes(4).toString('hex')}@example.com`;

    await signInByEmailLink(page, admin.id);
    await page.goto(`${WEBAPP_BASE_URL}/admin/users`);

    await page.getByRole('button', { name: 'Create User' }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(
      dialog.getByText('Create a new user. A welcome email tells them to sign in with a link sent to their email.'),
    ).toBeVisible();
    await expect(dialog.getByText('set their password')).toHaveCount(0);

    await dialog.getByLabel('Email').fill(email);
    await dialog.getByLabel('Name').fill('Task M New User');
    await dialog.getByTestId('dialog-create-user-button').click();

    const text = await waitForMailText(email);
    expect(text).toContain('We email you a link that signs you in.');
    expect(text).toContain(`${WEBAPP_BASE_URL}/signin`);
    expect(text.toLowerCase()).not.toContain('password');

    const created = await prisma.user.findFirstOrThrow({ where: { email } });
    expect(await prisma.passwordResetToken.count({ where: { userId: created.id } })).toBe(0);
  });
});
