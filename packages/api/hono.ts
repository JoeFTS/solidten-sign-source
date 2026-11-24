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
/**
 * Solid Ten Sign (R-2a): a request that says "content-type: application/json" but whose body is
 * empty or not valid JSON made ts-rest fail to parse it and answer 500 "Server Error" on any v1
 * route. It is answered here, in one place, with a plain 400.
 */
export const INVALID_JSON_BODY_MESSAGE =
  'The request body is not valid JSON. Send a JSON body, or leave out the "content-type: application/json" header when there is no body.';

const refuseInvalidJsonBody = async (request: Request): Promise<Response | null> => {
  const contentType = request.headers.get('content-type') ?? '';

  if (!/application\/json/i.test(contentType) || request.method === 'GET' || request.method === 'HEAD') {
    return null;
  }

  const body = await request.clone().text();

  try {
    JSON.parse(body);

    return null;
  } catch {
    return Response.json({ message: INVALID_JSON_BODY_MESSAGE }, { status: 400 });
  }
};

tsRestHonoApp.mount(
  '/',
  async (request) => {
    const invalidBody = await refuseInvalidJsonBody(request);

    if (invalidBody) {
      return invalidBody;
    }

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
