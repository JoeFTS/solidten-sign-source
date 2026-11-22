import { isSigninDisabledGlobally } from '@documenso/lib/constants/auth';
import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { assertUserNotDisabledById } from '@documenso/lib/server-only/user/assert-user-not-disabled';
import type { Context } from 'hono';

import type { HonoAuthContext } from '../../types/context';
import { createSession, generateSessionToken } from '../session/session';
import { setSessionCookie } from '../session/session-cookies';

type AuthorizeUser = {
  userId: number;
};

/**
 * Handles creating a session.
 *
 * Refuses to issue a session for a disabled account. This is the single
 * chokepoint shared by every sign-in path (email/password, passkey, OAuth,
 * OIDC, organisation OIDC), so the guard belongs here rather than in each
 * caller.
 */
export const onAuthorize = async (user: AuthorizeUser, c: Context<HonoAuthContext>) => {
  // Solid Ten Sign: the NEXT_PUBLIC_DISABLE_SIGNIN kill switch holds for every sign-in path
  // here, not only the routes that check it themselves (passkey and OAuth did not).
  if (isSigninDisabledGlobally()) {
    throw new AppError(AppErrorCode.NOT_SETUP, {
      message: 'Sign-in is turned off on this server.',
      userMessage: 'Sign-in is turned off on this server.',
      statusCode: 403,
    });
  }

  await assertUserNotDisabledById({ userId: user.userId });

  const metadata = c.get('requestMetadata');

  const sessionToken = generateSessionToken();

  await createSession(sessionToken, user.userId, metadata);

  await setSessionCookie(c, sessionToken);
};
