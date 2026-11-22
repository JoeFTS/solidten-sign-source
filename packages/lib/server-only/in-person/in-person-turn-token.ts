import { randomBytes } from 'node:crypto';
import { prisma } from '@documenso/prisma';
import { InPersonSigningPhase, SigningStatus } from '@prisma/client';

/**
 * Solid Ten Sign: the in-person device never holds the signer's link token.
 *
 * When a signer's turn starts, the server mints a turn credential. The signing
 * page on the device uses it wherever the normal page uses the link token. The
 * server swaps it for the real token on each request, and only when:
 * - the request carries the locked sign-in that runs the session,
 * - the session is still in the signer phase for that recipient,
 * - the recipient still has the same token and has not acted,
 * - the credential has not expired.
 *
 * Every way a turn ends clears the credential, so nothing on the device stays usable.
 */

export const IN_PERSON_TURN_TOKEN_PREFIX = 'ipt_';

/** 32 random bytes, base64url: 43 characters. */
const TURN_TOKEN_BODY_LENGTH = 43;

export const IN_PERSON_TURN_TOKEN_LIFETIME_MS = 2 * 60 * 60 * 1000;

export const createInPersonTurnToken = () => `${IN_PERSON_TURN_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;

export const getInPersonTurnTokenExpiry = (sessionExpiresAt: Date, now = new Date()) =>
  new Date(Math.min(now.getTime() + IN_PERSON_TURN_TOKEN_LIFETIME_MS, sessionExpiresAt.getTime()));

/** Fields that clear the credential. Spread into every update that ends a turn. */
export const CLEARED_TURN_TOKEN = { turnToken: null, turnTokenExpiresAt: null } as const;

/**
 * The real link token for a turn credential, or null when the credential is not
 * usable from this sign-in right now.
 */
export const exchangeInPersonTurnToken = async ({
  credential,
  authSessionId,
}: {
  credential: string;
  authSessionId: string | null | undefined;
}): Promise<string | null> => {
  if (!authSessionId || !credential.startsWith(IN_PERSON_TURN_TOKEN_PREFIX)) {
    return null;
  }

  const now = new Date();

  const session = await prisma.inPersonSigningSession.findUnique({
    where: { turnToken: credential },
  });

  if (
    !session ||
    session.authSessionId !== authSessionId ||
    session.phase !== InPersonSigningPhase.SIGNER ||
    session.endedAt ||
    session.expiresAt <= now ||
    !session.turnTokenExpiresAt ||
    session.turnTokenExpiresAt <= now ||
    !session.recipientId ||
    !session.recipientToken
  ) {
    return null;
  }

  // The sign-in must still be the one locked to this session.
  const authSession = await prisma.session.findUnique({
    where: { id: authSessionId },
    select: { stInPersonSessionId: true },
  });

  if (authSession?.stInPersonSessionId !== session.id) {
    return null;
  }

  const recipient = await prisma.recipient.findFirst({
    where: { id: session.recipientId, envelopeId: session.envelopeId },
    select: { token: true, signingStatus: true, envelope: { select: { deletedAt: true } } },
  });

  if (
    !recipient ||
    recipient.token !== session.recipientToken ||
    recipient.signingStatus !== SigningStatus.NOT_SIGNED ||
    recipient.envelope.deletedAt
  ) {
    return null;
  }

  return recipient.token;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const proto = Object.getPrototypeOf(value);

  return proto === Object.prototype || proto === null;
};

/**
 * Replace every string that `replace` maps, deep inside plain objects, arrays and
 * FormData. Other values (dates, files, buffers) are returned as they are.
 */
export const mapStringsDeep = (value: unknown, replace: (input: string) => string): unknown => {
  if (typeof value === 'string') {
    return replace(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => mapStringsDeep(item, replace));
  }

  if (typeof FormData !== 'undefined' && value instanceof FormData) {
    const next = new FormData();

    for (const [key, entry] of value.entries()) {
      if (typeof entry === 'string') {
        next.append(key, replace(entry));
      } else {
        next.append(key, entry);
      }
    }

    return next;
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStringsDeep(item, replace)]));
  }

  return value;
};

/**
 * Solid Ten Sign (SEC2-M1): the input keys that carry a recipient link token. A turn
 * credential is swapped only when it is the whole value of one of these keys. A credential
 * anywhere else (a comment, a field value, a name) is text the signer typed and stays as it is,
 * so the real link token is never written into something another person can read.
 */
export const RECIPIENT_TOKEN_INPUT_KEYS: ReadonlySet<string> = new Set(['token', 'recipientToken']);

const EXACT_TURN_TOKEN_PATTERN = new RegExp(`^${IN_PERSON_TURN_TOKEN_PREFIX}[A-Za-z0-9_-]{${TURN_TOKEN_BODY_LENGTH}}$`);

export const isInPersonTurnToken = (value: unknown): value is string =>
  typeof value === 'string' && EXACT_TURN_TOKEN_PATTERN.test(value);

/**
 * Map the string values held under token keys, deep inside plain objects, arrays and FormData.
 * Every other value is returned as it is.
 */
export const mapTokenFieldsDeep = (value: unknown, replace: (input: string) => string): unknown => {
  const visit = (item: unknown, key: string | null): unknown => {
    if (typeof item === 'string') {
      return key !== null && RECIPIENT_TOKEN_INPUT_KEYS.has(key) ? replace(item) : item;
    }

    if (Array.isArray(item)) {
      return item.map((entry) => visit(entry, null));
    }

    if (typeof FormData !== 'undefined' && item instanceof FormData) {
      const next = new FormData();

      for (const [entryKey, entry] of item.entries()) {
        next.append(entryKey, typeof entry === 'string' ? (visit(entry, entryKey) as string) : entry);
      }

      return next;
    }

    if (isPlainObject(item)) {
      return Object.fromEntries(Object.entries(item).map(([entryKey, entry]) => [entryKey, visit(entry, entryKey)]));
    }

    return item;
  };

  return visit(value, null);
};

/** The turn credentials that are the exact value of a token key. */
export const collectTurnTokenFields = (value: unknown) => {
  const found = new Set<string>();

  mapTokenFieldsDeep(value, (input) => {
    if (isInPersonTurnToken(input)) {
      found.add(input);
    }

    return input;
  });

  return found;
};

/** Swap exchanged credentials, exact token-key values only. */
export const replaceTurnTokenFields = <T>(value: T, exchanged: Map<string, string>): T =>
  mapTokenFieldsDeep(value, (input) => exchanged.get(input) ?? input) as T;

/**
 * Swap each turn credential held under a token key for the real link token.
 * A credential that does not exchange is left as it is: it matches no
 * recipient, so the request fails as any unknown link would.
 *
 * Returns the swapped input and the real tokens that were used, so the caller
 * can hide them again in the response.
 */
export const swapInPersonTurnTokensIn = async <T>({
  value,
  authSessionId,
}: {
  value: T;
  authSessionId: string | null | undefined;
}): Promise<{ value: T; swapped: Map<string, string> }> => {
  const swapped = new Map<string, string>();

  if (!authSessionId) {
    return { value, swapped };
  }

  const found = collectTurnTokenFields(value);

  if (found.size === 0) {
    return { value, swapped };
  }

  const exchanged = new Map<string, string>();

  for (const credential of found) {
    const token = await exchangeInPersonTurnToken({ credential, authSessionId });

    if (token) {
      exchanged.set(credential, token);
      swapped.set(token, credential);
    }
  }

  if (exchanged.size === 0) {
    return { value, swapped };
  }

  return { value: replaceTurnTokenFields(value, exchanged), swapped };
};

/**
 * Replace each real link token with its turn credential, deep inside a value
 * that is about to go to the device.
 */
export const hideRecipientTokensIn = <T>(value: T, credentialsByToken: Map<string, string>): T => {
  if (credentialsByToken.size === 0) {
    return value;
  }

  return mapStringsDeep(value, (input) => {
    let output = input;

    for (const [token, credential] of credentialsByToken) {
      if (output.includes(token)) {
        output = output.split(token).join(credential);
      }
    }

    return output;
  }) as T;
};
