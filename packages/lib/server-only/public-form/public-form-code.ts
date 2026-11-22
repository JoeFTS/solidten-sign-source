import { AccessAuth2FAEmailTemplate } from '@documenso/email/templates/access-auth-2fa';
import { prisma } from '@documenso/prisma';
import { msg } from '@lingui/core/macro';
import { Prisma } from '@prisma/client';
import { createElement } from 'react';

import { getI18nInstance } from '../../client-only/providers/i18n-server';
import { NEXT_PUBLIC_WEBAPP_URL } from '../../constants/app';
import { DIRECT_TEMPLATE_RECIPIENT_EMAIL } from '../../constants/direct-templates';
import { AppError, AppErrorCode } from '../../errors/app-error';
import type { RequestMetadata } from '../../universal/extract-request-metadata';
import { env } from '../../utils/env';
import {
  checkPublicFormOpenedToken,
  createPublicFormVerifiedProof,
  findPublicFormCodeCounter,
  generatePublicFormCode,
  isHoneypotFilled,
  PUBLIC_FORM_CODE_EXPIRATION_MINUTES,
  PUBLIC_FORM_CODE_PERIOD_MS,
  PUBLIC_FORM_MAX_WRONG_CODES,
} from '../../utils/public-form';
import { renderEmailWithI18N } from '../../utils/render-email-with-i18n';
import { verifyCaptchaToken } from '../captcha/verify-captcha';
import { getEmailContext } from '../email/get-email-context';
import { consumeDailyQuota, getNextDailyQuotaReset, readQuotaEnv, releaseDailyQuota } from '../rate-limit/daily-quota';
import { getBucket, parseWindow } from '../rate-limit/rate-limit';
import { getRetryAfterHeaders, TOO_MANY_REQUESTS_MESSAGE } from '../rate-limit/rate-limit-middleware';
import { recordServerCapReached } from '../rate-limit/server-cap-alerts';
import {
  assertPublicFormOpen,
  findPublicFormByToken,
  getFormEmailIdentifier,
  getPublicFormKey,
} from './find-public-form';
import { publicFormCodeRequestRateLimit, publicFormCodeVerifyRateLimit } from './public-form-rate-limits';

const WRONG_CODE_ACTION = 'st.form.wrong-code';

const PUBLIC_FORM_CODE_EMAILS_ACTION = 'st.public-form.code-emails';
const PUBLIC_FORM_CODE_EMAILS_SERVER_ACTION = 'st.public-form.code-emails-server';

/** Default ceilings: code emails per form per day, and for the whole server per day. */
export const PUBLIC_FORM_DAILY_CODE_CAP_DEFAULT = 200;
export const PUBLIC_FORM_SERVER_DAILY_CODE_CAP_DEFAULT = 2000;

const getPublicFormDailyCodeCap = () =>
  readQuotaEnv(env('NEXT_PRIVATE_ST_PUBLIC_FORM_DAILY_CODE_CAP'), PUBLIC_FORM_DAILY_CODE_CAP_DEFAULT);

const getPublicFormServerDailyCodeCap = () =>
  readQuotaEnv(env('NEXT_PRIVATE_ST_PUBLIC_FORM_SERVER_DAILY_CODE_CAP'), PUBLIC_FORM_SERVER_DAILY_CODE_CAP_DEFAULT);
const WRONG_CODE_WINDOW_MS = parseWindow('15m');

const findVerifiableForm = async (token: string) => {
  const found = await findPublicFormByToken(token);

  if (!found?.form) {
    throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Form not found' });
  }

  if (!found.form.requireVerifiedEmail) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, { message: 'This form does not verify email addresses.' });
  }

  assertPublicFormOpen(found.form);

  return { ...found, form: found.form };
};

const assertAllowed = (result: { isLimited: boolean; reset: Date }) => {
  if (result.isLimited) {
    throw new AppError(AppErrorCode.TOO_MANY_REQUESTS, {
      message: TOO_MANY_REQUESTS_MESSAGE,
      headers: getRetryAfterHeaders(result.reset),
    });
  }
};

export type RequestPublicFormCodeOptions = {
  token: string;
  email: string;
  /** Solid Ten Sign (S-M6): the signed "form opened" token from the form page. */
  openedToken?: string;
  honeypot?: string;
  captchaToken?: string;
  requestMetadata: RequestMetadata;
};

/**
 * Email a 6-digit code to the person filling in a form.
 */
export const requestPublicFormCode = async ({
  token,
  email: providedEmail,
  openedToken,
  honeypot,
  captchaToken,
  requestMetadata,
}: RequestPublicFormCodeOptions) => {
  const email = providedEmail.toLowerCase();
  const ip = requestMetadata.ipAddress ?? 'unknown';

  if (isHoneypotFilled(honeypot)) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, { message: 'The request was refused.' });
  }

  if (email === DIRECT_TEMPLATE_RECIPIENT_EMAIL) {
    throw new AppError(AppErrorCode.INVALID_BODY, { message: 'Enter your own email address.' });
  }

  const { form, envelope } = await findVerifiableForm(token);

  // Solid Ten Sign (S-M6): only a browser that opened this form page can ask for a code.
  const opened = checkPublicFormOpenedToken({
    key: getPublicFormKey(),
    formId: form.id,
    token: openedToken,
    now: new Date(),
  });

  if (opened !== 'OK' && opened !== 'TOO_FAST') {
    throw new AppError('PUBLIC_FORM_RELOAD', {
      message: 'This page has expired. Reload the page and try again.',
      statusCode: 400,
    });
  }

  assertAllowed(await publicFormCodeRequestRateLimit.check({ ip, identifier: getFormEmailIdentifier(form.id, email) }));

  await verifyCaptchaToken({ token: captchaToken, ipAddress: requestMetadata.ipAddress });

  // Solid Ten Sign (S-M6): daily ceilings on code emails, per form and for the whole server.
  const formQuota = { action: PUBLIC_FORM_CODE_EMAILS_ACTION, key: `form:${form.id}` };
  const serverQuota = { action: PUBLIC_FORM_CODE_EMAILS_SERVER_ACTION, key: 'server' };

  if (!(await consumeDailyQuota({ ...formQuota, max: getPublicFormDailyCodeCap() }))) {
    throw new AppError(AppErrorCode.TOO_MANY_REQUESTS, {
      message: 'This form has sent too many codes today. Please try again tomorrow.',
      headers: getRetryAfterHeaders(getNextDailyQuotaReset()),
    });
  }

  if (!(await consumeDailyQuota({ ...serverQuota, max: getPublicFormServerDailyCodeCap() }))) {
    await releaseDailyQuota(formQuota);

    await recordServerCapReached('PUBLIC_FORM_CODES');

    throw new AppError(AppErrorCode.TOO_MANY_REQUESTS, {
      message: 'Too many codes were sent today. Please try again tomorrow.',
      headers: getRetryAfterHeaders(getNextDailyQuotaReset()),
    });
  }

  const code = await generatePublicFormCode({
    key: getPublicFormKey(),
    formId: form.id,
    email,
    now: new Date(),
    generation: await getCodeGeneration(getFormEmailIdentifier(form.id, email)),
  });

  const { branding, emailLanguage, senderEmail, replyToEmail, emailTransport } = await getEmailContext({
    emailType: 'RECIPIENT',
    source: {
      type: 'team',
      teamId: envelope.teamId,
    },
    meta: envelope.documentMeta,
  });

  const i18n = await getI18nInstance(emailLanguage);

  const template = createElement(AccessAuth2FAEmailTemplate, {
    documentTitle: envelope.title,
    userName: email,
    userEmail: email,
    code,
    expiresInMinutes: PUBLIC_FORM_CODE_EXPIRATION_MINUTES,
    assetBaseUrl: NEXT_PUBLIC_WEBAPP_URL(),
  });

  const [html, text] = await Promise.all([
    renderEmailWithI18N(template, { lang: emailLanguage, branding }),
    renderEmailWithI18N(template, { lang: emailLanguage, branding, plainText: true }),
  ]);

  await emailTransport.sendMail({
    to: { address: email, name: '' },
    from: senderEmail,
    replyTo: replyToEmail,
    subject: i18n._(msg`Your verification code for ${envelope.title}`),
    html,
    text,
  });
};

const CODE_USED_ACTION = 'st.form.code-used';

const CODE_GENERATION_ACTION = 'st.form.code-generation';

const codeAlreadyUsed = () =>
  new AppError('PUBLIC_FORM_CODE_USED', {
    message: 'This code was already used. Ask for a new code.',
    statusCode: 400,
  });

// One row per form and address; its count is the generation (see getPublicFormHotpCounter).
const getCodeGenerationKey = (identifier: string) => ({
  key: `gen:${identifier}`,
  action: CODE_GENERATION_ACTION,
  bucket: new Date(0),
});

const getCodeGeneration = async (identifier: string) =>
  (await prisma.rateLimit.findUnique({ where: { key_action_bucket: getCodeGenerationKey(identifier) } }))?.count ?? 0;

const advanceCodeGeneration = async (identifier: string) => {
  const where = getCodeGenerationKey(identifier);

  await prisma.rateLimit.upsert({
    where: { key_action_bucket: where },
    create: { ...where, count: 1 },
    update: { count: { increment: 1 } },
  });
};

const markPublicFormCodeUsed = async ({
  identifier,
  counter,
  generation,
}: {
  identifier: string;
  counter: number;
  generation: number;
}) => {
  try {
    await prisma.rateLimit.create({
      data: {
        key: `used:${identifier}:g${generation}`,
        action: CODE_USED_ACTION,
        bucket: new Date(counter * PUBLIC_FORM_CODE_PERIOD_MS),
        count: 1,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw codeAlreadyUsed();
    }

    throw error;
  }
};

const getWrongCodeKey = (identifier: string) => ({
  key: `id:${identifier}`,
  action: WRONG_CODE_ACTION,
  bucket: getBucket(WRONG_CODE_WINDOW_MS),
});

// Not built on createRateLimit on purpose: this is a lockout, not a rate limit, so it must
// hold even where DANGEROUS_BYPASS_RATE_LIMITS turns rate limits off.
const countWrongCodes = async (identifier: string) => {
  const row = await prisma.rateLimit.findUnique({
    where: { key_action_bucket: getWrongCodeKey(identifier) },
  });

  return row?.count ?? 0;
};

const recordWrongCode = async (identifier: string) => {
  const where = getWrongCodeKey(identifier);

  const row = await prisma.rateLimit.upsert({
    where: { key_action_bucket: where },
    create: { ...where, count: 1 },
    update: { count: { increment: 1 } },
  });

  return row.count;
};

export type VerifyPublicFormCodeOptions = {
  token: string;
  email: string;
  code: string;
  requestMetadata: RequestMetadata;
};

/**
 * Check a code. Returns a proof the browser sends with the submission. After five wrong
 * codes for one address on one form, every code is refused for the rest of the 15 minute
 * window, including the right one.
 */
export const verifyPublicFormCode = async ({
  token,
  email: providedEmail,
  code,
  requestMetadata,
}: VerifyPublicFormCodeOptions) => {
  const email = providedEmail.toLowerCase();

  const { form } = await findVerifiableForm(token);

  assertAllowed(await publicFormCodeVerifyRateLimit.check({ ip: requestMetadata.ipAddress ?? 'unknown' }));

  const identifier = getFormEmailIdentifier(form.id, email);

  if ((await countWrongCodes(identifier)) >= PUBLIC_FORM_MAX_WRONG_CODES) {
    throw new AppError('PUBLIC_FORM_CODE_LOCKED', {
      message: 'Too many wrong codes. Wait 15 minutes, then ask for a new code.',
      statusCode: 429,
      // Solid Ten: the lock ends with the wrong-code window (LD3-L1).
      headers: getRetryAfterHeaders(new Date(getBucket(WRONG_CODE_WINDOW_MS).getTime() + WRONG_CODE_WINDOW_MS)),
    });
  }

  const key = getPublicFormKey();
  const now = new Date();

  const generation = await getCodeGeneration(identifier);
  const counter = await findPublicFormCodeCounter({ key, formId: form.id, email, code, now, generation });

  // The previous generation's code was just used (by this person or a parallel request): say so,
  // and do not count it as a wrong code.
  if (
    counter === null &&
    generation > 0 &&
    (await findPublicFormCodeCounter({ key, formId: form.id, email, code, now, generation: generation - 1 })) !== null
  ) {
    throw codeAlreadyUsed();
  }

  if (counter === null) {
    const wrongCount = await recordWrongCode(identifier);

    throw new AppError('PUBLIC_FORM_CODE_INVALID', {
      message:
        wrongCount >= PUBLIC_FORM_MAX_WRONG_CODES
          ? 'Too many wrong codes. Wait 15 minutes, then ask for a new code.'
          : 'The code is not correct.',
      statusCode: 400,
    });
  }

  // Solid Ten Sign (RT1-M3): one code, one proof. The insert fails when this form, address
  // and time step were already used, also when two verifies race.
  await markPublicFormCodeUsed({ identifier, counter, generation });

  // Solid Ten Sign (RT4-M3): the next request for this form and address gives a fresh code.
  await advanceCodeGeneration(identifier);

  return {
    proof: createPublicFormVerifiedProof({ key, formId: form.id, email, now }),
  };
};
