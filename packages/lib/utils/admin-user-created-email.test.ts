import { renderWithI18N } from '@documenso/email/render';
import { AdminUserCreatedTemplate } from '@documenso/email/templates/admin-user-created';
import { setupI18n } from '@lingui/core';
import React, { createElement } from 'react';
import { describe, expect, it } from 'vitest';

// The email templates use the classic JSX transform here; lib's vitest has no React plugin.
(globalThis as { React?: typeof React }).React = React;

// An empty English catalog: the test must not need the compiled catalogs.
const i18n = setupI18n({ locale: 'en', messages: { en: {} } });

describe('Solid Ten Sign (M): the welcome email for an admin-created user', () => {
  it('with password sign-in on, links to setting a password', async () => {
    const html = await renderWithI18N(
      createElement(AdminUserCreatedTemplate, {
        assetBaseUrl: 'http://localhost:3000',
        resetPasswordLink: 'http://localhost:3000/reset-password/abc',
      }),
      { i18n, plainText: true },
    );

    expect(html).toContain('Set Password');
    expect(html).toContain('http://localhost:3000/reset-password/abc');
  });

  it('with password sign-in off, links to the sign-in page and never mentions a password', async () => {
    const html = await renderWithI18N(
      createElement(AdminUserCreatedTemplate, {
        assetBaseUrl: 'http://localhost:3000',
        signInLink: 'http://localhost:3000/signin',
      }),
      { i18n, plainText: true },
    );

    expect(html).toContain('We email you a link that signs you in.');
    expect(html).toContain('http://localhost:3000/signin');
    expect(html).not.toContain('reset-password');
    expect(html.toLowerCase()).not.toContain('password');
  });
});
