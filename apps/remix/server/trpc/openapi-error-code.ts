import { getTopLevelErrorCode } from '@documenso/lib/errors/top-level-error-code';

/**
 * Solid Ten: an AppError answered by the v2 API gets a top-level code that matches its status
 * (a 4xx, or a 5xx such as SERVER_BUSY's 503) instead of trpc-to-openapi's INTERNAL_SERVER_ERROR.
 * The specific code stays in `data.code`. See getTopLevelErrorCode.
 */
export { getTopLevelErrorCode };

export const withMatchingTopLevelErrorCode = async (response: Response) => {
  if (response.status < 400 || !(response.headers.get('content-type') ?? '').includes('application/json')) {
    return response;
  }

  const body = (await response
    .clone()
    .json()
    .catch(() => null)) as { code?: string; data?: { appError?: { code?: string } } } | null;

  if (!body || body.code !== 'INTERNAL_SERVER_ERROR' || !body.data?.appError) {
    return response;
  }

  const code = getTopLevelErrorCode(response.status, body.data.appError.code);

  if (!code || code === body.code) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.delete('content-length');

  return new Response(JSON.stringify({ ...body, code }), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};
