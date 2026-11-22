import { getOptionalSession } from '@documenso/auth/server/lib/utils/get-session';
import { getInPersonLockId } from '@documenso/lib/server-only/in-person/in-person-lock';
import { type MiddlewareFunction, redirect } from 'react-router';

/**
 * Gate for the `_authenticated+` route tree. Lives in middleware rather than the
 * layout loader so it also runs when single fetch requests a subset of loaders
 * via `?_routes=`.
 *
 * Embed sessions only exist to sign inside an iframe and are treated as signed
 * out here.
 */
export const authenticatedMiddleware: MiddlewareFunction = async ({ request }, next) => {
  const { session } = await getOptionalSession(request);

  if (!session || session.isEmbed) {
    throw redirect('/signin');
  }

  // Solid Ten Sign: a sign-in handed to signers stays on the in-person screens.
  const inPersonLockId = await getInPersonLockId(session);

  if (inPersonLockId) {
    throw redirect(`/in-person/${inPersonLockId}`);
  }

  return next();
};
