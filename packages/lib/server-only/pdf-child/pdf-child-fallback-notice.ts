import { mailer } from '@documenso/email/mailer';
import { SolidTenNoticeTemplate } from '@documenso/email/templates/solidten-notice';
import { msg } from '@lingui/core/macro';
import { createElement } from 'react';

import { getI18nInstance } from '../../client-only/providers/i18n-server';
import { NEXT_PUBLIC_WEBAPP_URL } from '../../constants/app';
import { env } from '../../utils/env';
import { renderEmailWithI18N } from '../../utils/render-email-with-i18n';
import { getServerOperatorRecipients } from '../email/server-operators';

/**
 * Solid Ten: one email a day to the server operators when heavy PDF work ran in the app process
 * because the PDF child could not be used (LD4-L1).
 */
export const notifyOperatorsOfPdfChildFallback = async (reason: string) => {
  const to = await getServerOperatorRecipients();

  if (to.length === 0) {
    return;
  }

  const i18n = await getI18nInstance();
  const subject = i18n._(msg`Large documents are processed without the PDF process on Solid Ten Sign`);

  const template = createElement(SolidTenNoticeTemplate, {
    heading: subject,
    paragraphs: [
      i18n._(
        msg`Large documents are being processed in the app itself, because the separate PDF process could not be used (${reason}). The app keeps working, but a very large document can now use the app's memory.`,
      ),
      i18n._(
        msg`Check the server logs for "[PDF]" lines and fix the cause (for example the temp folder, or the PDF process files of the build). This notice is sent at most once a day.`,
      ),
    ],
    assetBaseUrl: NEXT_PUBLIC_WEBAPP_URL(),
  });

  const [html, text] = await Promise.all([
    renderEmailWithI18N(template),
    renderEmailWithI18N(template, { plainText: true }),
  ]);

  await mailer.sendMail({
    to,
    from: {
      name: env('NEXT_PRIVATE_SMTP_FROM_NAME') || 'Solid Ten Sign',
      address: env('NEXT_PRIVATE_SMTP_FROM_ADDRESS') || 'noreply@documenso.com',
    },
    subject,
    html,
    text,
  });
};
