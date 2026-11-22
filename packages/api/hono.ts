import { ApiContractV1 } from '@documenso/api/v1/contract';
import { ApiContractV1Implementation } from '@documenso/api/v1/implementation';
import { OpenAPIV1 } from '@documenso/api/v1/openapi';
import { testCredentialsHandler } from '@documenso/lib/server-only/public-api/test-credentials';
import { listDocumentsHandler } from '@documenso/lib/server-only/webhooks/zapier/list-documents';
import { subscribeHandler } from '@documenso/lib/server-only/webhooks/zapier/subscribe';
import { unsubscribeHandler } from '@documenso/lib/server-only/webhooks/zapier/unsubscribe';
// This is a bit nasty. Todo: Extract
import type { HonoEnv } from '@documenso/remix/server/router';
import { fetchRequestHandler, TsRestHttpError } from '@ts-rest/serverless/fetch';
import { Hono } from 'hono';

// This is bad, ts-router will be created on each request.
// But don't really have a choice here.
export const tsRestHonoApp = new Hono<HonoEnv>();

tsRestHonoApp
  .get('/openapi', (c) => c.redirect('https://openapi-v1.documenso.com'))
  .get('/openapi.json', (c) => c.json(OpenAPIV1))
  .get('/me', async (c) => testCredentialsHandler(c.req.raw));

// Zapier. Todo: (RR7) Check methods. Are these get/post/update requests?
tsRestHonoApp
  .all('/zapier/list-documents', async (c) => listDocumentsHandler(c.req.raw))
  .all('/zapier/subscribe', async (c) => subscribeHandler(c.req.raw))
  .all('/zapier/unsubscribe', async (c) => unsubscribeHandler(c.req.raw));

// The ts-rest contract paths are absolute (`/api/v1/...`), so the handler needs the request with its
// full path. Hono 4.13.18 strips the route prefix from a mounted request by default (4.13.13 did
// not), which made every v1 document and template route answer 404. So the request is rebuilt with
// its ORIGINAL url. It must be rebuilt, not passed through: under @hono/node-server 2.x the original
// is that library's own lightweight request object, and ts-rest's `new Request(request)` then throws
// ("Cannot read private member #state"), which answered 500 on every v1 route.
tsRestHonoApp.mount(
  '/',
  async (request) => {
    return fetchRequestHandler({
      request,
      contract: ApiContractV1,
      router: ApiContractV1Implementation,
      options: {
        errorHandler: (err) => {
          if (err instanceof TsRestHttpError && err.statusCode === 500) {
            console.error(err);
          }
        },
      },
    });
  },
  { replaceRequest: (request) => new Request(request.url, request) },
);
