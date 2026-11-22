import { isSigninDisabledGlobally } from '../../constants/auth';
import { AppError, AppErrorCode } from '../../errors/app-error';

/**
 * Solid Ten Sign: NEXT_PUBLIC_DISABLE_SIGNIN=true is the kill switch for every sign-in,
 * email links included. Both email-link routes refuse, for every address alike.
 */
export const assertEmailLinkSigninEnabled = () => {
  if (isSigninDisabledGlobally()) {
    throw new AppError(AppErrorCode.NOT_SETUP, {
      message: 'Sign-in is turned off on this server.',
      statusCode: 403,
    });
  }
};
