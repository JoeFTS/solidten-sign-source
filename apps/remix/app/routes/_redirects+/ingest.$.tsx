/**
 * https://posthog.com/docs/advanced/proxy/remix
 */
import { extractPostHogConfig } from '@documenso/lib/constants/feature-flags';
import { buildIngestProxyRequestHeaders, buildIngestProxyResponseHeaders } from '@documenso/lib/utils/ingest-proxy';

import type { Route } from './+types/ingest.$';

const API_HOST = 'eu.i.posthog.com';
const ASSET_HOST = 'eu-assets.i.posthog.com';

const posthogProxy = async (request: Request) => {
  // Solid Ten Sign (AUD-C9): no analytics key, no proxy.
  if (!extractPostHogConfig()) {
    return new Response('Not Found', { status: 404 });
  }

  const url = new URL(request.url);
  const hostname = url.pathname.startsWith('/ingest/static/') ? ASSET_HOST : API_HOST;

  const newUrl = new URL(url);
  newUrl.protocol = 'https';
  newUrl.hostname = hostname;
  newUrl.port = '443';
  newUrl.pathname = newUrl.pathname.replace(/^\/ingest/, '');

  // Solid Ten Sign (AUD-C9): no Cookie or Authorization to the analytics host, no redirects.
  const headers = buildIngestProxyRequestHeaders(request.headers, hostname);

  const fetchOptions: RequestInit = {
    method: request.method,
    headers,
    redirect: 'manual',
  };

  if (!['GET', 'HEAD'].includes(request.method)) {
    fetchOptions.body = request.body;
    // @ts-expect-error - It should exist
    fetchOptions.duplex = 'half';
  }

  const response = await fetch(newUrl, fetchOptions);

  // Solid Ten Sign (AUD-C9): never a Set-Cookie from the analytics host on our domain.
  const responseHeaders = buildIngestProxyResponseHeaders(response.headers);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
};

export async function loader({ request }: Route.LoaderArgs) {
  return posthogProxy(request);
}

export async function action({ request }: Route.ActionArgs) {
  return posthogProxy(request);
}
