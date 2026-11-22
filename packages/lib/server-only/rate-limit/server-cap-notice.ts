import { mailer } from '@documenso/email/mailer';
import { SolidTenNoticeTemplate } from '@documenso/email/templates/solidten-notice';
import { msg } from '@lingui/core/macro';
import { createElement } from 'react';

import { getI18nInstance } from '../../client-only/providers/i18n-server';
import { NEXT_PUBLIC_WEBAPP_URL } from '../../constants/app';
import { env } from '../../utils/env';
import { renderEmailWithI18N } from '../../utils/render-email-with-i18n';
import { getServerOperatorRecipients } from '../email/server-operators';
import { SERVER_CAPS, type TServerCap } from './server-cap-alerts';

/**
 * One email to the server operators (RT3-M1): what stopped, until when, and what to do.
 */
export const notifyAdminsOfServerCap = async (cap: TServerCap) => {
  const to = await getServerOperatorRecipients();

  if (to.length === 0) {
    return;
  }

  const i18n = await getI18nInstance();
  const what = SERVER_CAPS[cap];

  const template = createElement(SolidTenNoticeTemplate, {
    heading: i18n._(msg`A daily limit was reached on Solid Ten Sign`),
    paragraphs: [
      i18n._(msg`${what}: the server-wide limit for today was reached. No more are sent until 00:00 UTC.`),
      i18n._(
        msg`This can be heavy use, or someone sending requests on purpose. Check the server logs, and raise the limit in the server settings if the use is real.`,
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
    subject: i18n._(msg`A daily limit was reached on Solid Ten Sign`),
    html,
    text,
  });
};
