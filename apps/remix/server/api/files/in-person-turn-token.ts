import { getOptionalSession } from '@documenso/auth/server/lib/utils/get-session';
import {
  exchangeInPersonTurnToken,
  IN_PERSON_TURN_TOKEN_PREFIX,
} from '@documenso/lib/server-only/in-person/in-person-turn-token';
import type { Context } from 'hono';

/**
 * Solid Ten Sign: the in-person signing page sends a turn credential where a
 * link token goes. Swap it for the real token when the request comes from the
 * device that runs the turn. Anything else is returned as it is.
 */
export const resolveRecipientTokenParam = async (c: Context, token: string) => {
  if (!token.startsWith(IN_PERSON_TURN_TOKEN_PREFIX)) {
    return token;
  }

  const { session } = await getOptionalSession(c);

  return (await exchangeInPersonTurnToken({ credential: token, authSessionId: session?.id })) ?? token;
};
