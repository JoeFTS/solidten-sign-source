import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';

export type TCertificateAuthLevel =
  | 'ACCOUNT_REAUTH'
  | 'TWO_FACTOR_REAUTH'
  | 'PASSWORD_REAUTH'
  | 'PASSKEY_REAUTH'
  | 'ACCOUNT'
  | 'TWO_FACTOR'
  | 'EMAIL';

/**
 * The "Authentication Level" line of the signing certificate.
 *
 * A re-authentication at signing (action auth) wins. "No action auth" (EXPLICIT_NONE, the
 * value every field records when nothing was asked) is not a level of its own: the access
 * check then decides. Solid Ten Sign (FINDINGS 11): before, EXPLICIT_NONE printed "Email"
 * even when the signer had to sign in to an account or enter an emailed code to open the
 * document.
 */
export const getCertificateAuthLevel = ({
  actionAuth,
  accessAuth,
}: {
  actionAuth: string | undefined;
  accessAuth: string | undefined;
}): TCertificateAuthLevel => {
  switch (actionAuth) {
    case 'ACCOUNT':
      return 'ACCOUNT_REAUTH';
    case 'TWO_FACTOR_AUTH':
      return 'TWO_FACTOR_REAUTH';
    case 'PASSWORD':
      return 'PASSWORD_REAUTH';
    case 'PASSKEY':
      return 'PASSKEY_REAUTH';
    default:
      break;
  }

  switch (accessAuth) {
    case 'ACCOUNT':
      return 'ACCOUNT';
    case 'TWO_FACTOR_AUTH':
      return 'TWO_FACTOR';
    default:
      return 'EMAIL';
  }
};

export const CERTIFICATE_AUTH_LEVEL_LABELS: Record<TCertificateAuthLevel, MessageDescriptor> = {
  ACCOUNT_REAUTH: msg`Account Re-Authentication`,
  TWO_FACTOR_REAUTH: msg`Two-Factor Re-Authentication`,
  PASSWORD_REAUTH: msg`Password Re-Authentication`,
  PASSKEY_REAUTH: msg`Passkey Re-Authentication`,
  ACCOUNT: msg`Account Authentication`,
  TWO_FACTOR: msg`Two-Factor Authentication`,
  EMAIL: msg`Email`,
};
