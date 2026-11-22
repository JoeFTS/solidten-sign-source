import { getSessionCookie } from '@documenso/auth/server/lib/session/session-cookies';
import type { RateLimitCheckResult } from '@documenso/lib/server-only/rate-limit/rate-limit';
import { TOO_MANY_REQUESTS_MESSAGE } from '@documenso/lib/server-only/rate-limit/rate-limit-middleware';
import {
  apiTrpcFieldUploadRateLimit,
  apiTrpcRateLimit,
  apiTrpcSessionRateLimit,
  apiTrpcSigningRateLimit,
} from '@documenso/lib/server-only/rate-limit/rate-limits';
import { getIpAddress } from '@documenso/lib/universal/get-ip-address';
import { prisma } from '@documenso/prisma';
import { sha256 } from '@noble/hashes/sha2';
import type { Context, MiddlewareHandler } from 'hono';

/**
 * Solid Ten: the tRPC rate limit, keyed by who is calling (LD-M4).
 *
 * - Token-authorized signing calls are counted per recipient link (a hash of the token), with
 *   a per-IP backstop.
 * - Field-file uploads count against a per-IP ceiling here; the procedure keeps its own
 *   per-IP and per-recipient limits.
 * - Signed-in staff calls are counted per session, with a per-IP backstop.
 * - Everything else keeps the old 100 per minute per IP.
 *
 * Sign-in, public forms and comments have their own limits inside their routes; none of
 * those change here.
 */

export const TRPC_SIGNING_PROCEDURES = new Set([
  'field.signFieldWithToken',
  'field.removeSignedFieldWithToken',
  'envelope.field.sign',
  'recipient.completeDocumentWithToken',
  'recipient.rejectDocumentWithToken',
  'lifecycle.getSigningLinkStatus',
]);

const TRPC_FIELD_UPLOAD_PROCEDURE = 'fieldFile.upload';

/** JSON bodies above this are not inspected (signing inputs are small). */
const MAX_INSPECTED_BODY_BYTES = 256 * 1024;

export type TTrpcRateLimitTarget =
  | { kind: 'signing'; identifier: string }
  | { kind: 'field-upload' }
  | { kind: 'session'; identifier: string }
  | { kind: 'anonymous' };

/** A rate-limit key for a secret: never the secret itself. */
export const hashRateLimitKey = (value: string) => Buffer.from(sha256(value)).toString('hex').slice(0, 32);

export const getTrpcProcedurePaths = (url: URL) =>
  decodeURIComponent(url.pathname.replace(/^\/api\/trpc\//, ''))
    .split(',')
    .filter(Boolean);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The `token` of each call's input (tRPC wire format, batched or not, superjson `json` wrapper). */
export const getTrpcInputTokens = (input: unknown, callCount: number, isBatch: boolean): Array<string | null> => {
  const readToken = (call: unknown) => {
    const value = isRecord(call) && 'json' in call ? call.json : call;

    return isRecord(value) && typeof value.token === 'string' && value.token.length > 0 ? value.token : null;
  };

  if (!isBatch) {
    return [readToken(input)];
  }

  return Array.from({ length: callCount }, (_, index) => (isRecord(input) ? readToken(input[String(index)]) : null));
};

const readTrpcInput = async (request: Request, url: URL): Promise<unknown> => {
  if (request.method === 'GET') {
    const raw = url.searchParams.get('input');

    return raw ? JSON.parse(raw) : undefined;
  }

  const contentType = request.headers.get('content-type') ?? '';
  const length = Number(request.headers.get('content-length') ?? '0');

  if (!contentType.includes('application/json') || length > MAX_INSPECTED_BODY_BYTES) {
    return undefined;
  }

  return await request.clone().json();
};

const isRecipientToken = async (token: string) => {
  if (token.length > 255) {
    return false;
  }

  const recipient = await prisma.recipient.findFirst({ where: { token }, select: { id: true } });

  return recipient !== null;
};

export const resolveTrpcRateLimitTarget = async (
  request: Request,
  getSessionId: () => Promise<string | null>,
): Promise<TTrpcRateLimitTarget> => {
  const url = new URL(request.url);
  const paths = getTrpcProcedurePaths(url);
  const isBatch = url.searchParams.get('batch') === '1';

  if (paths.length > 0 && paths.every((path) => path === TRPC_FIELD_UPLOAD_PROCEDURE)) {
    return { kind: 'field-upload' };
  }

  if (paths.length > 0 && paths.every((path) => TRPC_SIGNING_PROCEDURES.has(path))) {
    const input = await readTrpcInput(request, url).catch(() => undefined);
    const tokens = getTrpcInputTokens(input, paths.length, isBatch);
    const [firstToken] = tokens;

    // One link per request; a mix falls back to the general keys below.
    // Solid Ten Sign: only a token that belongs to a recipient gets the per-link budget;
    // an invented or retired token is charged like any anonymous call.
    if (firstToken && tokens.every((token) => token === firstToken) && (await isRecipientToken(firstToken))) {
      return { kind: 'signing', identifier: `link:${hashRateLimitKey(firstToken)}` };
    }
  }

  const sessionId = await getSessionId().catch(() => null);

  if (sessionId) {
    return { kind: 'session', identifier: `session:${hashRateLimitKey(sessionId)}` };
  }

  return { kind: 'anonymous' };
};

// Solid Ten Sign (AUD-15): `count` is the number of calls in the request, not 1 per request.
const checkTarget = async (target: TTrpcRateLimitTarget, ip: string, count: number) => {
  switch (target.kind) {
    case 'signing':
      return await apiTrpcSigningRateLimit.check({ ip, identifier: target.identifier, count });
    case 'session':
      return await apiTrpcSessionRateLimit.check({ ip, identifier: target.identifier, count });
    case 'field-upload':
      return await apiTrpcFieldUploadRateLimit.check({ ip, count });
    default:
      return await apiTrpcRateLimit.check({ ip, count });
  }
};

export const TRPC_TOO_MANY_REQUESTS_MESSAGE = TOO_MANY_REQUESTS_MESSAGE;

/**
 * A 429 in the tRPC error shape (one entry per batched call), so the client gets a
 * TRPCClientError with code TOO_MANY_REQUESTS instead of an unreadable body.
 */
export const buildTrpcTooManyRequestsBody = (paths: string[], isBatch: boolean) => {
  const entry = (path: string) => ({
    error: {
      json: {
        message: TRPC_TOO_MANY_REQUESTS_MESSAGE,
        code: -32029,
        data: {
          code: 'TOO_MANY_REQUESTS',
          httpStatus: 429,
          path,
          appError: {
            code: 'TOO_MANY_REQUESTS',
            message: TRPC_TOO_MANY_REQUESTS_MESSAGE,
            userMessage: TRPC_TOO_MANY_REQUESTS_MESSAGE,
            statusCode: 429,
          },
        },
      },
    },
  });

  return isBatch ? paths.map(entry) : entry(paths[0] ?? '');
};

const setRateLimitHeaders = (c: Context, result: RateLimitCheckResult) => {
  c.header('X-RateLimit-Limit', String(result.limit));
  c.header('X-RateLimit-Remaining', String(result.remaining));
  c.header('X-RateLimit-Reset', String(Math.ceil(result.reset.getTime() / 1000)));
};

export const createTrpcRateLimitMiddleware = (): MiddlewareHandler => async (c, next) => {
  let ip: string;

  try {
    ip = getIpAddress(c.req.raw);
  } catch {
    ip = 'unknown';
  }

  const target = await resolveTrpcRateLimitTarget(c.req.raw, async () => await getSessionCookie(c));
  const callCount = Math.max(1, getTrpcProcedurePaths(new URL(c.req.url)).length);
  const result = await checkTarget(target, ip, callCount);

  setRateLimitHeaders(c, result);

  if (result.isLimited) {
    const url = new URL(c.req.url);

    c.header('Retry-After', String(Math.max(1, Math.ceil((result.reset.getTime() - Date.now()) / 1000))));

    return c.json(buildTrpcTooManyRequestsBody(getTrpcProcedurePaths(url), url.searchParams.get('batch') === '1'), 429);
  }

  await next();
};
