import { renderWithI18N } from '@documenso/email/render';
import { DocumentCompletedEmailTemplate } from '@documenso/email/templates/document-completed';
import { setupI18n } from '@lingui/core';
import React, { createElement } from 'react';
import { describe, expect, it } from 'vitest';

import { NEXT_PUBLIC_ST_SOURCE_URL } from '../constants/source-code';

// The email templates use the classic JSX transform here; lib's vitest has no React plugin.
(globalThis as { React?: typeof React }).React = React;

// An empty English catalog, as in sms/message.test.ts: the test must not need the compiled
// catalogs (translations/*/web.mjs are build output, not in git). Messages fall back to their source text.
const i18n = setupI18n({ locale: 'en', messages: { en: {} } });

const renderEmail = async (options: Omit<Parameters<typeof renderWithI18N>[1], 'i18n'> = {}) =>
  await renderWithI18N(template, { ...options, i18n });

const template = createElement(DocumentCompletedEmailTemplate, {
  documentName: 'Source link test',
  assetBaseUrl: 'http://localhost:3000',
  downloadLink: 'http://localhost:3000/d',
});

describe('email footer: the AGPL source link', () => {
  it('is next to "sent using Solid Ten Sign"', async () => {
    const html = await renderEmail();

    expect(html).toContain('This document was sent using');
    expect(html).toContain(`href="${NEXT_PUBLIC_ST_SOURCE_URL()}"`);
  });

  it('is there also when "sent using" is hidden by branding', async () => {
    const html = await renderEmail({
      branding: {
        brandingEnabled: true,
        brandingUrl: '',
        brandingLogo: '',
        brandingCompanyDetails: '',
        brandingHidePoweredBy: true,
      },
    });

    expect(html).not.toContain('This document was sent using');
    expect(html).toContain(`href="${NEXT_PUBLIC_ST_SOURCE_URL()}"`);
  });
});
