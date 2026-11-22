import type { Envelope, Recipient } from '@prisma/client';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { extractDocumentAuthMethods } from '../../utils/document-auth';
import { isSessionUserTheRecipient } from './is-session-user-the-recipient';

export const COMPLETION_OTHER_ACCOUNT_MESSAGE =
  'You are signed in with a different account. Sign in as the recipient, or sign out, to finish this document.';

export const ACTION_AUTH_SIGNED_OUT_MESSAGE =
  'Sign in as the recipient to finish, change or decline this document. It asks the recipient to confirm who they are.';

/**
 * Solid Ten Sign (AUD-C11 and its follow-up): on a document that asks for action auth (PASSWORD,
 * PASSKEY, authenticator 2FA or ACCOUNT), completing, un-signing a signed field and declining by
 * link follow the field step-up rule (AUD-10): the request must come from a session whose account
 * email is the recipient's. A signed-out holder of the link, or another account, is refused. Every
 * action method already needs that session for the field step-up, so the real recipient is signed
 * in. EXPLICIT_NONE and documents without action auth are unchanged.
 *
 * On a host's in-person device the caller passes no userId, as the field step-up does; in-person
 * signing never starts for a recipient with action auth (`getInPersonSignerBlockReason`).
 */
export const assertActionAuthActorIsRecipient = async ({
  documentAuth,
  recipient,
  userId,
}: {
  documentAuth: Envelope['authOptions'];
  recipient: Pick<Recipient, 'email' | 'authOptions'>;
  userId?: number;
}) => {
  const { recipientActionAuthRequired } = extractDocumentAuthMethods({
    documentAuth,
    recipientAuth: recipient.authOptions,
  });

  if (!recipientActionAuthRequired) {
    return;
  }

  if (userId === undefined) {
    throw new AppError(AppErrorCode.UNAUTHORIZED, {
      message: ACTION_AUTH_SIGNED_OUT_MESSAGE,
      userMessage: ACTION_AUTH_SIGNED_OUT_MESSAGE,
      statusCode: 401,
    });
  }

  if (await isSessionUserTheRecipient({ userId, recipientEmail: recipient.email })) {
    return;
  }

  throw new AppError(AppErrorCode.UNAUTHORIZED, {
    message: COMPLETION_OTHER_ACCOUNT_MESSAGE,
    userMessage: COMPLETION_OTHER_ACCOUNT_MESSAGE,
    statusCode: 401,
  });
};

export const assertCompletionActorIsRecipient = assertActionAuthActorIsRecipient;
