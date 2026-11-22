import { describe, expect, it } from 'vitest';

import { buildIngestProxyRequestHeaders, buildIngestProxyResponseHeaders } from './ingest-proxy';

describe('ingest proxy headers (AUD-C9)', () => {
  it('never forwards the sign-in cookie or an Authorization header to the analytics host', () => {
    const headers = buildIngestProxyRequestHeaders(
      new Headers({
        cookie: 'sessionId=secret',
        authorization: 'Bearer api_secret',
        'proxy-authorization': 'Basic secret',
        'content-type': 'application/json',
        'user-agent': 'test-agent',
      }),
      'eu.i.posthog.com',
    );

    expect(headers.get('cookie')).toBeNull();
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('proxy-authorization')).toBeNull();
    expect(headers.get('host')).toBe('eu.i.posthog.com');
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('user-agent')).toBe('test-agent');
  });

  it('never passes a Set-Cookie from the analytics host back to the browser', () => {
    const headers = buildIngestProxyResponseHeaders(
      new Headers({ 'set-cookie': 'tracker=1; Domain=sign.example', 'content-type': 'application/json' }),
    );

    expect(headers.get('set-cookie')).toBeNull();
    expect(headers.get('content-type')).toBe('application/json');
  });
});
