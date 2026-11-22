import { mailer } from '@documenso/email/mailer';
import { EmailLinkSigninTemplate } from '@documenso/email/templates/email-link-signin';
import { prisma } from '@documenso/prisma';
import { msg } from '@lingui/core/macro';
import crypto from 'crypto';
import { createElement } from 'react';

import { getI18nInstance } from '../../client-only/providers/i18n-server';
import { NEXT_PUBLIC_WEBAPP_URL } from '../../constants/app';
import { env } from '../../utils/env';
import { renderEmailWithI18N } from '../../utils/render-email-with-i18n';

export const EMAIL_LINK_SIGNIN_IDENTIFIER = 'email-link-signin';
export const EMAIL_LINK_SIGNIN_TTL_MINUTES = 15;
/**
 * Solid Ten Sign (S-M1): live links are never cancelled by a new request. Past this many
 * unexpired, unused links a request is answered as usual but no link is issued; the
 * existing links are all in the owner's inbox and expire on their own.
 */
export const EMAIL_LINK_SIGNIN_MAX_LIVE_LINKS = 10;

/** Only the SHA-256 hash of a sign-in token is stored, so a database read cannot be replayed as a sign-in. */
export const hashEmailLinkToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

/**
 * Issues a single-use sign-in link for an existing, enabled user and emails it.
 * Up to EMAIL_LINK_SIGNIN_MAX_LIVE_LINKS links can be live at once; each still works one time.
 * Does nothing for unknown emails, so the caller can always answer the same way.
 * Returns whether a link was issued.
 */
export const sendEmailLinkSignin = async ({ email }: { email: string }) => {
  const user = await prisma.user.findFirst({
    where: {
      email: email.toLowerCase(),
    },
  });

  if (!user || user.disabled) {
    return false;
  }

  const token = crypto.randomBytes(32).toString('hex');

  // A new request must never cancel a link the person may be about to use, or anyone who knows
  // the address could keep cancelling it. Only used and expired links are removed.
  const isIssued = await prisma.$transaction(async (tx) => {
    // One request at a time per user, so parallel requests cannot all pass the live-link cap.
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${user.id} FOR UPDATE`;

    const live = await tx.verificationToken.findMany({
      where: {
        userId: user.id,
        identifier: EMAIL_LINK_SIGNIN_IDENTIFIER,
      },
      orderBy: {
        createdAt: 'desc',
      },
      select: {
        id: true,
        completed: true,
        expires: true,
      },
    });

    const now = Date.now();
    const isUsable = (row: (typeof live)[number]) => !row.completed && row.expires.valueOf() > now;
    const usableCount = live.filter(isUsable).length;
    const dropIds = live.filter((row) => !isUsable(row)).map((row) => row.id);

    if (dropIds.length > 0) {
      await tx.verificationToken.deleteMany({
        where: {
          id: {
            in: dropIds,
          },
        },
      });
    }

    if (usableCount >= EMAIL_LINK_SIGNIN_MAX_LIVE_LINKS) {
      return false;
    }

    await tx.verificationToken.create({
      data: {
        identifier: EMAIL_LINK_SIGNIN_IDENTIFIER,
        token: hashEmailLinkToken(token),
        expires: new Date(now + EMAIL_LINK_SIGNIN_TTL_MINUTES * 60 * 1000),
        userId: user.id,
      },
    });

    return true;
  });

  if (!isIssued) {
    return false;
  }

  const assetBaseUrl = NEXT_PUBLIC_WEBAPP_URL() || 'http://localhost:3000';

  // The token rides in the URL fragment, which browsers never send to a server or write to access logs.
  const signInLink = `${assetBaseUrl}/email-link#token=${token}`;

  const template = createElement(EmailLinkSigninTemplate, {
    assetBaseUrl,
    signInLink,
    expiresInMinutes: EMAIL_LINK_SIGNIN_TTL_MINUTES,
  });

  const [html, text] = await Promise.all([
    renderEmailWithI18N(template),
    renderEmailWithI18N(template, { plainText: true }),
  ]);

  const i18n = await getI18nInstance();

  await mailer.sendMail({
    to: {
      address: user.email,
      name: user.name || '',
    },
    from: {
      name: env('NEXT_PRIVATE_SMTP_FROM_NAME') || 'Solid Ten Sign',
      address: env('NEXT_PRIVATE_SMTP_FROM_ADDRESS') || 'noreply@documenso.com',
    },
    subject: i18n._(msg`Your sign-in link`),
    html,
    text,
  });

  return true;
};
