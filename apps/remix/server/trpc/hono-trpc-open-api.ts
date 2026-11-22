import { API_V2_BETA_URL, API_V2_URL, formatPath } from '@documenso/lib/constants/app';
import { AppError, genericErrorCodeToTrpcErrorCodeMap } from '@documenso/lib/errors/app-error';
import { createTrpcContext } from '@documenso/trpc/server/context';
import { appRouter } from '@documenso/trpc/server/router';
import { createOpenApiFetchHandler } from '@documenso/trpc/utils/openapi-fetch-handler';
import { handleTrpcRouterError } from '@documenso/trpc/utils/trpc-error-handler';
import type { Context } from 'hono';

import { withMatchingTopLevelErrorCode } from './openapi-error-code';

type OpenApiTrpcServerHandlerOptions = {
  isBeta: boolean;
};

export const openApiTrpcServerHandler = async (c: Context, { isBeta }: OpenApiTrpcServerHandlerOptions) => {
  const endpoint = formatPath(isBeta ? API_V2_BETA_URL : API_V2_URL) as `/${string}`;

  const response = await createOpenApiFetchHandler<typeof appRouter>({
    endpoint,
    router: appRouter,
    createContext: async () => createTrpcContext({ c, requestSource: 'apiV2' }),
    req: c.req.raw,
    onError: (opts) => handleTrpcRouterError(opts, 'apiV2'),
    // Not sure why we need to do this since we handle it in errorFormatter which runs after this.
    responseMeta: (opts) => {
      if (opts.errors[0]?.cause instanceof AppError) {
        const appError = AppError.parseError(opts.errors[0].cause);

        const httpStatus = genericErrorCodeToTrpcErrorCodeMap[appError.code]?.status ?? 400;

        // Solid Ten: Retry-After and the like travel with the error (SERVER_BUSY, rate limits).
        return {
          status: httpStatus,
          ...(appError.headers ? { headers: appError.headers } : {}),
        };
      }

      return {};
    },
  });

  // Solid Ten: a 4xx AppError answers a matching top-level code, not INTERNAL_SERVER_ERROR.
  return await withMatchingTopLevelErrorCode(response);
};
