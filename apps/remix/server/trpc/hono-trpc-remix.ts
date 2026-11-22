import { formatPath } from '@documenso/lib/constants/app';
import { createTrpcContext } from '@documenso/trpc/server/context';
import { appRouter } from '@documenso/trpc/server/router';
import { TRPC_MAX_BATCH_SIZE } from '@documenso/trpc/utils/batch-limit';
import { handleTrpcRouterError } from '@documenso/trpc/utils/trpc-error-handler';
import { trpcServer } from '@hono/trpc-server';

/**
 * Trpc server for internal routes like /api/trpc/*
 *
 * `endpoint` must include the sub-path prefix (e.g. "/ESign") because the
 * @hono/trpc-server adapter slices the prefix off the full URL pathname to
 * compute the procedure name. Hono's `basePath` doesn't rewrite the URL.
 */
export const reactRouterTrpcServer = trpcServer({
  router: appRouter,
  endpoint: formatPath('/api/trpc'),
  // Solid Ten Sign (AUD-15): one request cannot carry an unbounded number of calls.
  maxBatchSize: TRPC_MAX_BATCH_SIZE,
  createContext: async (_, c) => createTrpcContext({ c, requestSource: 'app' }),
  onError: (opts) => handleTrpcRouterError(opts, 'trpc'),
});
