import { tsRestHonoApp } from '@documenso/api/hono';
import { auth } from '@documenso/auth/server';
import { rejectEmbedSessionMiddleware } from '@documenso/auth/server/lib/session/embed-session-restrictions';
import { csc } from '@documenso/ee/server-only/signing/csc/hono';
import { createDatabaseError, toPublicDatabaseError } from '@documenso/lib/errors/database-errors';
import { jobsClient } from '@documenso/lib/jobs/client';
import { createJobShutdownMiddleware } from '@documenso/lib/jobs/client/graceful-shutdown';
import { LicenseClient } from '@documenso/lib/server-only/license/license-client';
import { createRateLimitMiddleware } from '@documenso/lib/server-only/rate-limit/rate-limit-middleware';
import {
  aiRateLimit,
  apiV1RateLimit,
  apiV2RateLimit,
  fileUploadRateLimit,
} from '@documenso/lib/server-only/rate-limit/rate-limits';
import { TelemetryClient } from '@documenso/lib/server-only/telemetry/telemetry-client';
import { migrateDeletedAccountServiceAccount } from '@documenso/lib/server-only/user/service-accounts/deleted-account';
import { migrateLegacyServiceAccount } from '@documenso/lib/server-only/user/service-accounts/legacy-service-account';
import { env } from '@documenso/lib/utils/env';
import { logger } from '@documenso/lib/utils/logger';
import { openApiDocument } from '@documenso/trpc/server/open-api';
import { Hono } from 'hono';
import { contextStorage } from 'hono/context-storage';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import type { RequestIdVariables } from 'hono/request-id';
import { requestId } from 'hono/request-id';
import type { Logger } from 'pino';
import { aiRoute } from './api/ai/route';
import { downloadRoute } from './api/download/download';
import { filesRoute } from './api/files/files';
import { fieldFileUploadBodyLimit } from './api/files/routes/get-field-file';
import { type AppContext, appContext } from './context';
import { csrfMiddleware } from './csrf-middleware';
import { appMiddleware } from './middleware';
import { securityHeadersMiddleware } from './security-headers';
import { openApiTrpcServerHandler } from './trpc/hono-trpc-open-api';
import { reactRouterTrpcServer } from './trpc/hono-trpc-remix';
import { createTrpcRateLimitMiddleware } from './trpc-rate-limit';

// Re-export so the rollup build (entry: server/router.ts) bundles
// load-context.ts. server/main.js imports getLoadContext from the rolled-up
// output to wire it into the React Router adapter.
export { getLoadContext } from './load-context';

export interface HonoEnv {
  Variables: RequestIdVariables & {
    context: AppContext;
    logger: Logger;
    cspNonce: string;
  };
}

const basePath = (env('NEXT_PUBLIC_BASE_PATH') ?? '').replace(/\/$/, '');

const app = new Hono<HonoEnv>().basePath(basePath || '/');

// Solid Ten (DISK-L1): an error no route handled never answers with database internals.
app.onError((error, c) => {
  if (error instanceof HTTPException) {
    return error.getResponse();
  }

  const databaseError = toPublicDatabaseError(error, `${c.req.method} ${c.req.path}`);

  if (!databaseError) {
    console.error(`[SERVER]: ${c.req.method} ${c.req.path} failed`, error);
  }

  const answer = databaseError ?? createDatabaseError();

  for (const [name, value] of Object.entries(answer.headers ?? {})) {
    c.header(name, value);
  }

  return c.json({ error: answer.message, code: answer.code }, answer.statusCode === 503 ? 503 : 500);
});

/**
 * Database-backed rate limiting for API routes.
 */
const apiV1RateLimitMiddleware = createRateLimitMiddleware(apiV1RateLimit);
const apiV2RateLimitMiddleware = createRateLimitMiddleware(apiV2RateLimit);
const aiRateLimitMiddleware = createRateLimitMiddleware(aiRateLimit);
// Solid Ten: keyed per signing link, per session, or per IP (trpc-rate-limit.ts).
const trpcRateLimitMiddleware = createTrpcRateLimitMiddleware();
const fileRateLimitMiddleware = createRateLimitMiddleware(fileUploadRateLimit);

/**
 * Attach session and context to requests.
 */
app.use(contextStorage());
app.use(appContext);

/**
 * Emit response security headers (CSP with per-request nonce, plus
 * Referrer-Policy and X-Content-Type-Options on embed routes). Must run
 * after `contextStorage()` so the nonce is readable via `getContext()` from
 * `getLoadContext`, and before the React Router handler so the response
 * carries the header.
 */
app.use(securityHeadersMiddleware);

/**
 * RR7 app middleware.
 */
app.use('*', appMiddleware);
app.use('*', requestId());
app.use(async (c, next) => {
  const metadata = c.get('context').requestMetadata;

  const honoLogger = logger.child({
    requestId: c.var.requestId,
    requestPath: c.req.path,
    ipAddress: metadata.ipAddress,
    userAgent: metadata.userAgent,
  });

  c.set('logger', honoLogger);

  await next();
});

// CSRF: mount on every route that accepts a session cookie. Must run after the logger.
// Not mounted on `/api/v1` (Authorization header only, see `authenticatedMiddleware`),
// `/api/jobs` (signature auth) or `/api/csc` (GET only).
app.use('/api/auth/*', csrfMiddleware);
app.use('/api/trpc/*', csrfMiddleware);
app.use('/api/v2/*', csrfMiddleware);
app.use('/api/v2-beta/*', csrfMiddleware);
app.use('/api/files/*', csrfMiddleware);
app.use('/api/ai/*', csrfMiddleware);

// Embed sessions are signing-only. `/api/files` instead ignores them per route
// (`getOptionalNonEmbedSession`) so embedded authoring on a host that also ran
// embedded signing still falls through to its presign token.
app.use('/api/ai/*', rejectEmbedSessionMiddleware);

// Apply cors and rate limits to API routes.
app.use(`/api/v1/*`, cors());
app.use('/api/v1/*', apiV1RateLimitMiddleware);
app.use(`/api/v2/*`, cors());
app.use('/api/v2/*', apiV2RateLimitMiddleware);
app.use(`/api/v2-beta/*`, cors());
app.use('/api/v2-beta/*', apiV2RateLimitMiddleware);

// Auth server.
app.route('/api/auth', auth);

// Files route.
app.use('/api/files/upload-pdf', fileRateLimitMiddleware);
app.route('/api/files', filesRoute);

// AI route.
app.use('/api/ai/*', aiRateLimitMiddleware);
app.route('/api/ai', aiRoute);

// CSC OAuth routes (mounted from @documenso/ee).
app.route('/api/csc', csc);

// API servers.
app.route('/api/v1', tsRestHonoApp);
// Solid Ten: refuses job runs while the app shuts down, counts those in flight (FS3-M1).
app.use('/api/jobs/*', createJobShutdownMiddleware());
app.use('/api/jobs/*', jobsClient.getApiHandler());

app.use('/api/trpc/fieldFile.upload', fieldFileUploadBodyLimit);
app.use('/api/trpc/*', trpcRateLimitMiddleware);
app.use('/api/trpc/*', reactRouterTrpcServer);

// Unstable API server routes. Order matters for these two.
app.get(`/api/v2/openapi.json`, (c) => c.json(openApiDocument));
// Shadows the download routes that tRPC defines since tRPC-to-openapi doesn't support their return types.
app.route(`/api/v2`, downloadRoute);
app.use(`/api/v2/*`, async (c) =>
  openApiTrpcServerHandler(c, {
    isBeta: false,
  }),
);

// Unstable API server routes. Order matters for these two.
app.get(`/api/v2-beta/openapi.json`, (c) => c.json(openApiDocument));
// Shadows the download routes that tRPC defines since tRPC-to-openapi doesn't support their return types.
app.route(`/api/v2-beta`, downloadRoute);
app.use(`/api/v2-beta/*`, async (c) =>
  openApiTrpcServerHandler(c, {
    isBeta: true,
  }),
);

// Start telemetry client for anonymous usage tracking.
// Can be disabled by setting DOCUMENSO_DISABLE_TELEMETRY=true
if (env('NODE_ENV') !== 'development') {
  void TelemetryClient.start();
}

// Start license client to verify license on startup.
void LicenseClient.start();

// Start cron scheduler for background jobs (e.g. envelope expiration sweep).
// No-op for Inngest provider which handles cron externally.
jobsClient.startCron();

void migrateDeletedAccountServiceAccount();
void migrateLegacyServiceAccount();

export default app;

// Solid Ten: the production entry (main.js) installs the SIGTERM drain with its HTTP server.
export { installGracefulShutdown } from '@documenso/lib/jobs/client/graceful-shutdown';
