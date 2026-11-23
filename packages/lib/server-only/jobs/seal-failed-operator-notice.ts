import { mailer } from '@documenso/email/mailer';
import { SolidTenNoticeTemplate } from '@documenso/email/templates/solidten-notice';
import type { I18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { createElement } from 'react';

import { getI18nInstance } from '../../client-only/providers/i18n-server';
import { NEXT_PUBLIC_WEBAPP_URL } from '../../constants/app';
import { DOCUMENSO_INTERNAL_EMAIL } from '../../constants/email';
import { renderEmailWithI18N } from '../../utils/render-email-with-i18n';
import { getServerOperatorRecipients } from '../email/server-operators';

/** The text of the seal-failed notice, the same for the owner and the operators (S-2). */
export const sealFailedNoticeText = (i18n: I18n, { title, isRejected }: { title: string; isRejected: boolean }) => ({
  subject: i18n._(msg`"${title}": the final PDF could not be made`),
  heading: i18n._(msg`The final PDF could not be made`),
  paragraphs: [
    isRejected
      ? i18n._(
          msg`"${title}" was rejected by a recipient, but Solid Ten Sign could not make the final PDF. The document still shows as pending.`,
        )
      : i18n._(
          msg`"${title}" is signed by everyone, but Solid Ten Sign could not make the final PDF. The document still shows as pending, and the signed copies have not been sent.`,
        ),
    // F-4: a rejection is not a signature; the 6 hours count from it.
    isRejected
      ? i18n._(
          msg`Solid Ten Sign keeps trying for 6 hours after the rejection. You do not need to do anything if it works.`,
        )
      : i18n._(
          msg`Solid Ten Sign keeps trying for 6 hours after the last signature. You do not need to do anything if it works.`,
        ),
    i18n._(
      msg`If the document still shows as pending after that, an administrator must open it in the admin panel and use "Reseal document".`,
    ),
  ],
});

/**
 * Solid Ten Sign (S-2 follow-up): the server operators' copy of the seal-failed notice.
 *
 * Like the other operator notices (a daily cap reached, the PDF process cannot start): a
 * server-health message through the system mailer, from the server's own sender, in the default
 * language, without team branding, and NOT subject to the team's or organisation's email
 * settings. The owner's copy is team mail and keeps obeying them. `excludeAddress` drops the
 * owner when the owner gets their own copy (no duplicate). `beforeSend` is the at-most-once marker.
 */
export const notifyOperatorsOfSealFailed = async ({
  envelopeId,
  title,
  isRejected,
  excludeAddress,
  beforeSend,
}: {
  envelopeId: string;
  title: string;
  isRejected: boolean;
  excludeAddress?: string;
  beforeSend?: () => Promise<void>;
}) => {
  const excluded = excludeAddress?.toLowerCase();
  const to = (await getServerOperatorRecipients()).filter((person) => person.address.toLowerCase() !== excluded);

  if (to.length === 0) {
    return;
  }

  const i18n = await getI18nInstance();
  const { subject, heading, paragraphs } = sealFailedNoticeText(i18n, { title, isRejected });

  const template = createElement(SolidTenNoticeTemplate, {
    heading,
    paragraphs,
    actionLabel: i18n._(msg`Open in the admin panel`),
    actionLink: `${NEXT_PUBLIC_WEBAPP_URL()}/admin/documents/${envelopeId}`,
    assetBaseUrl: NEXT_PUBLIC_WEBAPP_URL(),
    isOperatorNotice: true,
  });

  const [html, text] = await Promise.all([
    renderEmailWithI18N(template),
    renderEmailWithI18N(template, { plainText: true }),
  ]);

  await beforeSend?.();

  await mailer.sendMail({
    to,
    // The server's own sender (NEXT_PRIVATE_SMTP_FROM_*), as for the app's other system mail (F-4).
    from: DOCUMENSO_INTERNAL_EMAIL,
    subject,
    html,
    text,
  });
};
