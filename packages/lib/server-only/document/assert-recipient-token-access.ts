import { prisma } from '@documenso/prisma';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { isRecipientAuthorized } from './is-recipient-authorized';

export const RECIPIENT_ACCOUNT_REQUIRED_MESSAGE =
  'Sign in with the account this document was sent to before you continue.';

/**
 * Solid Ten Sign (SEC3-C1): the recipient's ACCESS requirement for anything done with a signing
 * link token. Upstream checked it only in the signing page loaders: a recipient whose access needs
 * a signed-in account could still be signed, completed, declined and given files with the link
 * alone, signed out.
 *
 * The rule is the loaders' rule (isRecipientAuthorized, type ACCESS): an ACCOUNT recipient needs a
 * sign-in as the account with the recipient's email. A two-factor access code is checked where it
 * is entered, as before. `userId` must come from a browser session (an embed session counts, as it
 * does for the signing page and the file routes); an API token and a sign-in locked for in-person
 * signing never count.
 *
 * A token that matches no recipient is left to the route (it answers as for any unknown link).
 */
export const assertRecipientTokenAccess = async ({ token, userId }: { token: string; userId?: number }) => {
  const recipient = await prisma.recipient.findFirst({
    where: { token },
    select: {
      email: true,
      envelopeId: true,
      authOptions: true,
      envelope: { select: { authOptions: true } },
    },
  });

  if (!recipient) {
    return;
  }

  const isAuthorized = await isRecipientAuthorized({
    type: 'ACCESS',
    documentAuthOptions: recipient.envelope.authOptions,
    recipient,
    userId,
  });

  if (!isAuthorized) {
    throw new AppError(AppErrorCode.UNAUTHORIZED, {
      message: RECIPIENT_ACCOUNT_REQUIRED_MESSAGE,
      userMessage: RECIPIENT_ACCOUNT_REQUIRED_MESSAGE,
      statusCode: 401,
    });
  }
};

const RECIPIENT_TOKEN_KEYS = ['token', 'recipientToken'] as const;

const addToken = (out: Set<string>, value: unknown) => {
  if (typeof value === 'string' && value.length > 0) {
    out.add(value);
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const collectFromRecord = (input: unknown, out: Set<string>, isWrapped: boolean) => {
  if (!isRecord(input)) {
    return;
  }

  for (const key of RECIPIENT_TOKEN_KEYS) {
    addToken(out, input[key]);
  }

  if (isRecord(input.access)) {
    addToken(out, input.access.token);
  }

  // Solid Ten Sign (AUD-C11 note): a JSON `payload` object carries the same fields as the
  // FormData `payload` part (defence in depth; today the upload schema refuses JSON).
  if (isRecord(input.payload)) {
    for (const key of RECIPIENT_TOKEN_KEYS) {
      addToken(out, input.payload[key]);
    }
  }

  // A superjson `json` wrapper, one level only. Never `authOptions` / `accessAuthOptions`:
  // their two-factor `token` is a code, not a link token.
  if (!isWrapped && 'json' in input) {
    collectFromRecord(input.json, out, true);
  }
};

/**
 * Solid Ten Sign (AUD-6): every recipient link token in a request input, at each position a
 * procedure reads one from: a top-level `token` or `recipientToken` (the signing-certificate
 * route), or `access.token` (the envelope item list by token), in JSON, superjson or FormData
 * (parts, and a JSON `payload` part).
 *
 * All of them, not the first one found: an extra `token` that matches no recipient must not hide
 * the token the procedure then acts on.
 */
export const readRecipientTokensFromInput = (input: unknown): string[] => {
  const out = new Set<string>();

  if (typeof FormData !== 'undefined' && input instanceof FormData) {
    for (const key of RECIPIENT_TOKEN_KEYS) {
      for (const value of input.getAll(key)) {
        addToken(out, value);
      }
    }

    // A file upload sends its fields as a JSON `payload` part.
    for (const payload of input.getAll('payload')) {
      if (typeof payload !== 'string') {
        continue;
      }

      try {
        collectFromRecord(JSON.parse(payload), out, true);
      } catch {
        // Not JSON: the procedure's schema refuses it.
      }
    }

    return [...out];
  }

  collectFromRecord(input, out, false);

  return [...out];
};
