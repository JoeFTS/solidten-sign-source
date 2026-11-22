import { assertNotEmbedSession } from '@documenso/auth/server/lib/session/embed-session-restrictions';
import { AppError, AppErrorCode, genericErrorCodeToTrpcErrorCodeMap } from '@documenso/lib/errors/app-error';
import { toPublicDatabaseError } from '@documenso/lib/errors/database-errors';
import { createServerBusyError, isTransactionTimeoutError } from '@documenso/lib/errors/server-busy';
import {
  assertRecipientTokenAccess,
  readRecipientTokensFromInput,
} from '@documenso/lib/server-only/document/assert-recipient-token-access';
import { assertNotInPersonLocked } from '@documenso/lib/server-only/in-person/assert-not-in-person-locked';
import { getInPersonLockId } from '@documenso/lib/server-only/in-person/in-person-lock';
import {
  hideRecipientTokensIn,
  swapInPersonTurnTokensIn,
} from '@documenso/lib/server-only/in-person/in-person-turn-token';
import { getApiTokenByToken } from '@documenso/lib/server-only/public-api/get-api-token-by-token';
import { assertUserNotDisabled } from '@documenso/lib/server-only/user/assert-user-not-disabled';
import type { TrpcApiLog } from '@documenso/lib/types/api-logs';
import type { ApiRequestMetadata } from '@documenso/lib/universal/extract-request-metadata';
import { alphaid } from '@documenso/lib/universal/id';
import { isAdmin } from '@documenso/lib/utils/is-admin';
import { initTRPC, TRPCError } from '@trpc/server';
import type { AnyZodObject } from 'zod';

import { dataTransformer } from '../utils/data-transformer';
import type { TrpcContext } from './context';

// Can't import type from trpc-to-openapi because it breaks build, not sure why.
export type TrpcRouteMeta = {
  openapi?: {
    enabled?: boolean;
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
    path: `/${string}`;
    summary?: string;
    description?: string;
    protect?: boolean;
    tags?: string[];
    // eslint-disable-next-line @typescript-eslint/ban-types
    contentTypes?: ('application/json' | 'application/x-www-form-urlencoded' | (string & {}))[];
    deprecated?: boolean;
    requestHeaders?: AnyZodObject;
    responseHeaders?: AnyZodObject;
    successDescription?: string;
    errorResponses?: number[] | Record<number, string>;
  };
  /**
   * Embed sessions exist only to let a recipient sign inside an iframe and are
   * rejected by `authenticatedProcedure` (and downgraded to anonymous by
   * `maybeAuthenticatedProcedure`) unless the route opts in here.
   */
  allowEmbedSession?: boolean;
} & Record<string, unknown>;

const t = initTRPC
  .meta<TrpcRouteMeta>()
  .context<TrpcContext>()
  .create({
    transformer: dataTransformer,
    errorFormatter(opts) {
      const { shape, error, ctx } = opts;

      const originalError = error.cause;

      let data: Record<string, unknown> = shape.data;

      // Default unknown errors to 400, since if you're throwing an AppError it is expected
      // that you already know what you're doing.
      if (originalError instanceof AppError) {
        if (originalError.headers && ctx) {
          for (const [headerKey, headerValue] of Object.entries(originalError.headers)) {
            ctx.res.headers.append(headerKey, headerValue);
          }
        }

        data = {
          ...data,
          appError: AppError.toJSON(originalError),
          code: originalError.code,
          httpStatus: originalError.statusCode ?? genericErrorCodeToTrpcErrorCodeMap[originalError.code]?.status ?? 400,
        };
      }

      return {
        ...shape,
        data,
      };
    },
  });

/**
 * Middlewares
 */
export const authenticatedMiddleware = t.middleware(async ({ ctx, next, path, meta }) => {
  // Auth-independent log bindings. `auth` is set per-branch below since it
  // depends on which auth path was taken; `ctx.metadata.auth` here is still
  // `null` (the resolved value is set in the `next()` call below).
  const baseLogAttributes: TrpcApiLog = {
    path,
    auth: null,
    source: ctx.metadata.source,
    trpcMiddleware: 'authenticated',
    unverifiedTeamId: ctx.teamId,
  };

  const authorizationHeader = ctx.req.headers.get('authorization');

  const isApiV2 = Boolean(meta?.openapi?.path);

  // Taken from `authenticatedMiddleware` in `@documenso/api/v1/middleware/authenticated.ts`.
  if (authorizationHeader && isApiV2) {
    // Support for both "Authorization: Bearer api_xxx" and "Authorization: api_xxx"
    const [token] = (authorizationHeader || '').split('Bearer ').filter((s) => s.length > 0);

    if (!token) {
      throw new Error('Token was not provided for authenticated middleware');
    }

    const apiToken = await getApiTokenByToken({ token });

    // Reject API requests from a disabled account. The token may still be
    // present in the DB (e.g. before `disableUser` runs) so we enforce here.
    assertUserNotDisabled(apiToken.user);

    const trpcApiV2Logger = ctx.logger.child({
      ...baseLogAttributes,
      auth: 'api',
      userId: apiToken.user.id,
      apiTokenId: apiToken.id,
    } satisfies TrpcApiLog);

    trpcApiV2Logger.info({
      position: 'trpcProcedure',
    });

    return await next({
      ctx: {
        ...ctx,
        logger: trpcApiV2Logger,
        user: apiToken.user,
        teamId: apiToken.teamId,
        session: null,
        metadata: {
          ...ctx.metadata,
          auditUser: apiToken.team
            ? {
                id: null,
                email: null,
                name: apiToken.team.name,
              }
            : {
                id: apiToken.user.id,
                email: apiToken.user.email,
                name: apiToken.user.name,
              },
          auth: 'api',
        } satisfies ApiRequestMetadata,
      },
    });
  }

  if (!ctx.session) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Invalid session or API token.',
    });
  }

  // Reject session requests from a disabled account. The session may still be
  // valid (sessions aren't invalidated by `disableUser`), so we gate every
  // authenticated TRPC call here.
  assertUserNotDisabled(ctx.user);

  if (!meta?.allowEmbedSession) {
    assertNotEmbedSession(ctx.session);
  }

  // Solid Ten Sign: a sign-in handed to signers for in-person signing cannot reach the host's account.
  await assertNotInPersonLocked(ctx.session);

  // Recreate the logger with a sub request ID to differentiate between batched
  // requests, as well as identifying attributes so every subsequent log line
  // (including errors) inherits them.
  const trpcSessionLogger = ctx.logger.child({
    ...baseLogAttributes,
    auth: 'session',
    nonBatchedRequestId: alphaid(),
    userId: ctx.user.id,
    apiTokenId: null,
  } satisfies TrpcApiLog);

  trpcSessionLogger.info({
    position: 'trpcProcedure',
  });

  return await next({
    ctx: {
      ...ctx,
      teamId: ctx.teamId || -1,
      logger: trpcSessionLogger,
      user: ctx.user,
      session: ctx.session,
      metadata: {
        ...ctx.metadata,
        auditUser: {
          id: ctx.user.id,
          name: ctx.user.name,
          email: ctx.user.email,
        },
        auth: 'session',
      } satisfies ApiRequestMetadata,
    },
  });
});

export const maybeAuthenticatedMiddleware = t.middleware(async ({ ctx, next, path, meta }) => {
  const baseLogAttributes: TrpcApiLog = {
    path,
    auth: null,
    source: ctx.metadata.source,
    trpcMiddleware: 'maybeAuthenticated',
    unverifiedTeamId: ctx.teamId,
  };

  const authorizationHeader = ctx.req.headers.get('authorization');

  const isApiV2 = Boolean(meta?.openapi?.path);

  // Taken from `authenticatedMiddleware` in `@documenso/api/v1/middleware/authenticated.ts`.
  if (authorizationHeader && isApiV2) {
    // Support for both "Authorization: Bearer api_xxx" and "Authorization: api_xxx"
    const [token] = (authorizationHeader || '').split('Bearer ').filter((s) => s.length > 0);

    if (!token) {
      throw new Error('Token was not provided for authenticated middleware');
    }

    const apiToken = await getApiTokenByToken({ token });

    // Reject API requests from a disabled account. Presenting an API token is
    // an explicit attempt to act under that account, so we don't downgrade to
    // anonymous here — we reject.
    assertUserNotDisabled(apiToken.user);

    // Attach identifying attributes to the logger so every subsequent log line
    // within this request (including errors) inherits them.
    const trpcApiV2Logger = ctx.logger.child({
      ...baseLogAttributes,
      auth: 'api',
      userId: apiToken.user.id,
      apiTokenId: apiToken.id,
    } satisfies TrpcApiLog);

    trpcApiV2Logger.info({
      position: 'trpcProcedure',
    });

    return await next({
      ctx: {
        ...ctx,
        logger: trpcApiV2Logger,
        user: apiToken.user,
        teamId: apiToken.teamId,
        session: null,
        metadata: {
          ...ctx.metadata,
          auditUser: apiToken.team
            ? {
                id: null,
                email: null,
                name: apiToken.team.name,
              }
            : {
                id: apiToken.user.id,
                email: apiToken.user.email,
                name: apiToken.user.name,
              },
          auth: 'api',
        } satisfies ApiRequestMetadata,
      },
    });
  }

  // Treat a disabled session as anonymous. Most routes wired through
  // `maybeAuthenticatedProcedure` are signer/invite flows that key off an
  // input token rather than `ctx.user`, so downgrading lets those keep
  // working while routes that genuinely need an account naturally fall
  // through to their own auth checks. Embed sessions get the same treatment
  // unless the route has opted in via `allowEmbedSession`.
  const isEmbedSessionAllowed = !ctx.session?.isEmbed || Boolean(meta?.allowEmbedSession);

  // Solid Ten Sign (S-L1): a sign-in locked for in-person signing is anonymous here too.
  const inPersonLock = await findInPersonLock(ctx);

  const sessionUser = ctx.user && !ctx.user.disabled && isEmbedSessionAllowed && !inPersonLock ? ctx.user : null;
  const sessionRecord = sessionUser ? ctx.session : null;

  // Resolve `auth` once so it stays in sync between the logger bindings and
  // the outgoing metadata.
  const auth = sessionRecord ? 'session' : null;

  // Recreate the logger with a sub request ID to differentiate between batched
  // requests, as well as identifying attributes so every subsequent log line
  // (including errors) inherits them.
  const trpcSessionLogger = ctx.logger.child({
    ...baseLogAttributes,
    auth,
    nonBatchedRequestId: alphaid(),
    userId: sessionUser?.id,
    apiTokenId: null,
  } satisfies TrpcApiLog);

  trpcSessionLogger.info({
    position: 'trpcProcedure',
  });

  return await next({
    ctx: {
      ...ctx,
      logger: trpcSessionLogger,
      user: sessionUser,
      session: sessionRecord,
      inPersonLock,
      metadata: {
        ...ctx.metadata,
        auditUser: sessionUser
          ? {
              id: sessionUser.id,
              name: sessionUser.name,
              email: sessionUser.email,
            }
          : undefined,
        auth,
      } satisfies ApiRequestMetadata,
    },
  });
});

export const adminMiddleware = t.middleware(async ({ ctx, next, path }) => {
  if (!ctx.session || !ctx.user) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'You must be logged in to perform this action.',
    });
  }

  // Disabled admins shouldn't be able to do anything either.
  assertUserNotDisabled(ctx.user);

  assertNotEmbedSession(ctx.session);

  await assertNotInPersonLocked(ctx.session);

  const isUserAdmin = isAdmin(ctx.user);

  if (!isUserAdmin) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Not authorized to perform this action.',
    });
  }

  // Recreate the logger with a sub request ID to differentiate between batched
  // requests, as well as identifying attributes so every subsequent log line
  // (including errors) inherits them.
  const trpcSessionLogger = ctx.logger.child({
    nonBatchedRequestId: alphaid(),
    unverifiedTeamId: ctx.teamId,
    path,
    auth: 'session',
    source: ctx.metadata.source,
    userId: ctx.user.id,
    apiTokenId: null,
    trpcMiddleware: 'admin',
  } satisfies TrpcApiLog);

  trpcSessionLogger.info({
    position: 'trpcProcedure',
  });

  return await next({
    ctx: {
      ...ctx,
      logger: trpcSessionLogger,
      user: ctx.user,
      session: ctx.session,
      metadata: {
        ...ctx.metadata,
        auditUser: {
          id: ctx.user.id,
          name: ctx.user.name,
          email: ctx.user.email,
        },
        auth: 'session',
      } satisfies ApiRequestMetadata,
    },
  });
});

/**
 * Solid Ten Sign (S-L1): the locked sign-in and its user, when this request carries one.
 * Costs nothing for ordinary sign-ins: the marker is on the session row already loaded.
 */
const findInPersonLock = async (ctx: TrpcContext) => {
  if (!ctx.session?.stInPersonSessionId || !ctx.user) {
    return null;
  }

  return (await getInPersonLockId(ctx.session)) ? { session: ctx.session, user: ctx.user } : null;
};

export const procedureMiddleware = t.middleware(async ({ ctx, next, path }) => {
  // Recreate the logger with a sub request ID to differentiate between batched
  // requests, as well as identifying attributes so every subsequent log line
  // (including errors) inherits them.
  const trpcSessionLogger = ctx.logger.child({
    nonBatchedRequestId: alphaid(),
    unverifiedTeamId: ctx.teamId,
    path,
    auth: ctx.metadata.auth,
    source: ctx.metadata.source,
    userId: ctx.user?.id,
    apiTokenId: null,
    trpcMiddleware: 'procedure',
  } satisfies TrpcApiLog);

  trpcSessionLogger.info({
    position: 'trpcProcedure',
  });

  // Solid Ten Sign (S-L1): public procedures never see the host behind a locked sign-in.
  const inPersonLock = await findInPersonLock(ctx);

  const nextCtx: TrpcContext = inPersonLock
    ? {
        ...ctx,
        logger: trpcSessionLogger,
        user: null,
        session: null,
        inPersonLock,
        metadata: { ...ctx.metadata, auth: null },
      }
    : { ...ctx, logger: trpcSessionLogger, inPersonLock: null };

  return await next({ ctx: nextCtx });
});

/**
 * Solid Ten Sign: on an in-person device the signing page holds a turn credential,
 * never the signer's link token. Swap it for the link token before the procedure
 * runs, and swap it back in the response. Ordinary sign-ins skip this.
 */
const inPersonTurnTokenMiddleware = t.middleware(async ({ ctx, next, getRawInput }) => {
  if (!ctx.session?.stInPersonSessionId) {
    return next();
  }

  const { value, swapped } = await swapInPersonTurnTokensIn({
    value: await getRawInput(),
    authSessionId: ctx.session.id,
  });

  if (swapped.size === 0) {
    return next();
  }

  const result = await next({ getRawInput: async () => value });

  return result.ok ? { ...result, data: hideRecipientTokensIn(result.data, swapped) } : result;
});

/**
 * Solid Ten Sign (SEC3-C1): every procedure that takes a signing link token applies the
 * recipient's ACCESS requirement before it runs, with one rule for all of them
 * (assertRecipientTokenAccess, the signing page's rule). Before, only the page loaders checked
 * it: an ACCOUNT recipient could be signed and completed with the link alone.
 *
 * It runs after the in-person swap (so it sees the real token) and before the auth middlewares,
 * on the raw sign-in: a browser session counts, an embed session counts, a disabled account, an
 * API token or a sign-in locked for in-person signing does not.
 *
 * Exempt, on purpose:
 * - envelope.recipient.report: reporting an abusive sender from the email link must work
 *   without the account; it shows no document and changes no field.
 * - lifecycle.getSigningLinkStatus: tells an old link that it was passed on; shows nothing else.
 */
const RECIPIENT_TOKEN_ACCESS_EXEMPT_PATHS = new Set(['envelope.recipient.report', 'lifecycle.getSigningLinkStatus']);

const recipientTokenAccessMiddleware = t.middleware(async ({ ctx, next, path, getRawInput }) => {
  if (RECIPIENT_TOKEN_ACCESS_EXEMPT_PATHS.has(path)) {
    return next();
  }

  // Solid Ten Sign (AUD-6): every token the input carries, so a decoy cannot hide the real one.
  const tokens = readRecipientTokensFromInput(await getRawInput().catch(() => undefined));

  if (tokens.length === 0) {
    return next();
  }

  const isSignedIn = Boolean(ctx.session && ctx.user && !ctx.user.disabled);
  const inPersonLock = isSignedIn ? await findInPersonLock(ctx) : null;

  for (const token of tokens) {
    await assertRecipientTokenAccess({
      token,
      userId: isSignedIn && !inPersonLock ? ctx.user?.id : undefined,
    });
  }

  return next();
});

/**
 * Solid Ten: a database transaction that ran out of time (the Node thread was busy) is reported
 * as SERVER_BUSY, HTTP 503 with Retry-After, never as a 500 carrying Prisma's text (LD2-A).
 */
const serverBusyMiddleware = t.middleware(async ({ next }) => {
  const result = await next();

  if (!result.ok && (isTransactionTimeoutError(result.error.cause) || isTransactionTimeoutError(result.error))) {
    throw createServerBusyError();
  }

  // Solid Ten: a database that cannot take requests (full disk, unreachable) is a plain 503; any
  // other database error a plain 500. Never Prisma's text (DISK-L1).
  const databaseError = result.ok ? null : toPublicDatabaseError(result.error, 'a tRPC call');

  if (databaseError) {
    throw databaseError;
  }

  // Solid Ten: a limit checked inside a procedure (comments, public forms, ...) answers the same
  // 429 as the limiter in front of tRPC: top-level code -32029, appError and Retry-After kept
  // (LD3-L1).
  if (!result.ok && result.error.code !== 'TOO_MANY_REQUESTS') {
    const cause = result.error.cause;

    if (cause instanceof AppError && (cause.statusCode === 429 || cause.code === AppErrorCode.TOO_MANY_REQUESTS)) {
      throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: cause.message, cause });
    }
  }

  return result;
});

const baseProcedure = t.procedure.use(serverBusyMiddleware);

/**
 * Routers and Procedures
 */
export const router = t.router;
export const procedure = baseProcedure
  .use(inPersonTurnTokenMiddleware)
  .use(recipientTokenAccessMiddleware)
  .use(procedureMiddleware);
export const authenticatedProcedure = baseProcedure.use(recipientTokenAccessMiddleware).use(authenticatedMiddleware);
// While this is functionally the same as `procedure`, it's useful for indicating purpose
export const maybeAuthenticatedProcedure = baseProcedure
  .use(inPersonTurnTokenMiddleware)
  .use(recipientTokenAccessMiddleware)
  .use(maybeAuthenticatedMiddleware);
export const adminProcedure = baseProcedure.use(adminMiddleware);
