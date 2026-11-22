/**
 * Solid Ten Sign (AUD-C9): the analytics proxy (`/ingest/*`) talks to a third-party host.
 * It must never hand that host the sign-in cookie or an API token, and never let that host
 * set cookies on our domain.
 */

const STRIPPED_REQUEST_HEADERS = ['cookie', 'authorization', 'proxy-authorization'];

const STRIPPED_RESPONSE_HEADERS = ['set-cookie', 'content-encoding', 'content-length', 'transfer-encoding'];

export const buildIngestProxyRequestHeaders = (incoming: Headers, host: string) => {
  const headers = new Headers(incoming);

  for (const name of STRIPPED_REQUEST_HEADERS) {
    headers.delete(name);
  }

  headers.set('host', host);

  return headers;
};

export const buildIngestProxyResponseHeaders = (incoming: Headers) => {
  const headers = new Headers(incoming);

  for (const name of STRIPPED_RESPONSE_HEADERS) {
    headers.delete(name);
  }

  return headers;
};
