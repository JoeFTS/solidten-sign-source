import { env } from '../../utils/env';
import { createPublicFormOpenedToken, getPublicFormAvailability } from '../../utils/public-form';
import { getRetryAfterHeaders } from '../rate-limit/rate-limit-middleware';
import { findPublicFormByToken, getPublicFormKey } from './find-public-form';
import { publicFormOpenRateLimit } from './public-form-rate-limits';

export type PublicFormForVisitor = NonNullable<Awaited<ReturnType<typeof getPublicFormForVisitor>>>;

/**
 * What the form page needs to know before it shows the document. Returns null for a direct
 * link that is not a public form. Throws a 429 Response when the IP or the form opens the
 * page too often, so loaders can rethrow it.
 */
export const getPublicFormForVisitor = async ({ token, ipAddress }: { token: string; ipAddress?: string }) => {
  const found = await findPublicFormByToken(token);

  if (!found?.form) {
    return null;
  }

  const { form } = found;

  const rateLimit = await publicFormOpenRateLimit.check({ ip: ipAddress ?? 'unknown', identifier: form.id });

  if (rateLimit.isLimited) {
    throw new Response('Too many requests. Wait a moment, then try again.', {
      status: 429,
      headers: getRetryAfterHeaders(rateLimit.reset),
    });
  }

  const now = new Date();

  return {
    token,
    formId: form.id,
    availability: getPublicFormAvailability(form, now),
    opensAt: form.opensAt,
    closesAt: form.closesAt,
    introText: form.introText,
    redirectUrl: form.redirectUrl,
    requireVerifiedEmail: form.requireVerifiedEmail,
    openedToken: createPublicFormOpenedToken({ key: getPublicFormKey(), formId: form.id, now }),
    hasCaptcha: Boolean(env('NEXT_PUBLIC_TURNSTILE_SITE_KEY')),
  };
};
