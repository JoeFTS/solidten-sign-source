import { genericErrorCodeToTrpcErrorCodeMap } from './app-error';

/**
 * Solid Ten: the top-level `code` of a v2 API error body. trpc-to-openapi writes the wrapping
 * TRPCError's code there, which is INTERNAL_SERVER_ERROR for every AppError. The answer now
 * names the code that matches its HTTP status: the AppError's own mapping when its status is the
 * one sent (SERVER_BUSY gives SERVICE_UNAVAILABLE for 503), else the usual name of a 4xx status.
 * Returns null when the body should be left as it is (other 5xx answers).
 */
const STATUS_TO_TRPC_CODE: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_SUPPORTED',
  408: 'TIMEOUT',
  409: 'CONFLICT',
  412: 'PRECONDITION_FAILED',
  413: 'PAYLOAD_TOO_LARGE',
  422: 'UNPROCESSABLE_CONTENT',
  429: 'TOO_MANY_REQUESTS',
};

export const getTopLevelErrorCode = (status: number, appErrorCode: string | undefined): string | null => {
  const mapped = appErrorCode ? genericErrorCodeToTrpcErrorCodeMap[appErrorCode] : undefined;

  if (mapped && mapped.status === status) {
    return mapped.code;
  }

  if (status >= 400 && status < 500) {
    return STATUS_TO_TRPC_CODE[status] ?? 'BAD_REQUEST';
  }

  return null;
};
