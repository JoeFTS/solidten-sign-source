import { AppError } from '@documenso/lib/errors/app-error';
import { assertNotInPersonLocked } from '@documenso/lib/server-only/in-person/assert-not-in-person-locked';
import { getInPersonLockId } from '@documenso/lib/server-only/in-person/in-person-lock';
import type { Session } from '@prisma/client';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';

import { AuthenticationErrorCode } from '../errors/error-codes';
import type { SessionValidationResult } from '../session/session';
import { getOptionalSession } from '../utils/get-session';

/**
 * Embed sessions exist only to let a recipient sign inside an iframe. Anything
 * else is refused so a leaked embed session is not enough to act on the account.
 * TRPC routes opt in via `allowEmbedSession` meta; Hono routes mount
 * `rejectEmbedSessionMiddleware`.
 */
export const assertNotEmbedSession = (session: Pick<Session, 'isEmbed'> | null | undefined): void => {
  if (!session?.isEmbed) {
    return;
  }

  throw new AppError(AuthenticationErrorCode.EmbedSessionRestricted, {
    message: 'This action is not available from an embedded session. Sign in to Documenso directly to continue.',
    statusCode: 403,
  });
};

/**
 * Resolves the session but treats an embed session as anonymous. For routes
 * that fall back to a token when there is no session, so a partitioned embed
 * cookie left by a signing iframe does not shadow the token (e.g. embedded
 * authoring on the same host after embedded signing).
 */
export const getOptionalNonEmbedSession = async (c: Context | Request): Promise<SessionValidationResult> => {
  const result = await getOptionalSession(c);

  // Solid Ten Sign: a sign-in handed to signers for in-person signing is also
  // treated as signed out, so the host's files cannot be fetched from it.
  if (result.session?.isEmbed || (result.session && (await getInPersonLockId(result.session)))) {
    return {
      isAuthenticated: false,
      session: null,
      user: null,
    };
  }

  return result;
};

// Anonymous requests pass through so the route's own `getSession` produces its usual 401.
export const rejectEmbedSessionMiddleware = createMiddleware(async (c: Context, next) => {
  const { session } = await getOptionalSession(c);

  assertNotEmbedSession(session);

  if (session) {
    await assertNotInPersonLocked(session);
  }

  await next();
});
