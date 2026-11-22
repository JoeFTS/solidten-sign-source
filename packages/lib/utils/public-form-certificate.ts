import type { I18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';

/**
 * The certificate's authentication level for a recipient who came in through a public form.
 * Null for every other recipient, so the normal level is shown.
 */
export const formatPublicFormAuthLevel = (emailVerified: boolean | undefined, i18n: I18n) => {
  if (emailVerified === undefined) {
    return null;
  }

  return emailVerified
    ? i18n._(msg`Public form, email verified by code`)
    : i18n._(msg`Public form, email not verified`);
};
