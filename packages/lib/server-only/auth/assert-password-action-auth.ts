import { AppError, AppErrorCode } from '../../errors/app-error';
import { isPasswordSigninAvailable } from '../../utils/password-signin-availability';

export const PASSWORD_ACTION_AUTH_REFUSED_MESSAGE =
  '"Require password" cannot be used on this server: password sign-in is turned off, so signers cannot have a password. Choose another option, such as an emailed code.';

/**
 * Solid Ten Sign (N-5): with password sign-in off no signer can have a password, so a new
 * "Require password" (PASSWORD action auth) would lock every signer out. Refused with a 400 on
 * every create and update path (web app, API v1 and v2).
 *
 * `previous` is what is stored now: a document or recipient that already has PASSWORD keeps it
 * (it may be saved again unchanged), so nothing that exists breaks.
 */
export const assertPasswordActionAuthAllowed = (
  next: readonly (string | null)[] | null | undefined,
  previous: readonly (string | null)[] | null | undefined = [],
) => {
  if (isPasswordSigninAvailable() || !next?.includes('PASSWORD') || previous?.includes('PASSWORD')) {
    return;
  }

  throw new AppError(AppErrorCode.INVALID_BODY, {
    message: PASSWORD_ACTION_AUTH_REFUSED_MESSAGE,
    statusCode: 400,
  });
};
