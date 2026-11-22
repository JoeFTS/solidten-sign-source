import { describe, expect, it } from 'vitest';

import { isPublicUnicastIp } from './ip-classification';
import { isPrivateUrl } from './is-private-url';
import { buildWebhookRequestHeaders } from './webhook-request-headers';
import { isWebhookUrlAllowed } from './webhook-url-rule';

// Solid Ten Sign (S-L4): the forms the security review got past the old filter, and the
// rest of the IANA special-purpose ranges.
describe('isPrivateUrl: public unicast only', () => {
  it.each([
    'http://[::7f00:1]/', // IPv4-compatible IPv6 for 127.0.0.1
    'http://0.1.2.3/', // 0.0.0.0/8
    'http://[fe90::1]/', // fe80::/10 beyond fe80:
    'http://[febf::1]/',
    'http://[64:ff9b::7f00:1]/', // NAT64 of 127.0.0.1
    'http://[64:ff9b::10.0.0.1]/',
    'http://198.18.0.1/', // benchmarking 198.18.0.0/15
    'http://198.19.255.255/',
    'http://192.0.0.1/',
    'http://192.0.2.1/',
    'http://198.51.100.7/',
    'http://203.0.113.1/',
    'http://224.0.0.1/',
    'http://240.0.0.1/',
    'http://255.255.255.255/',
    'http://[ff02::1]/',
    'http://[2001:db8::1]/',
    'http://[2002:7f00:1::]/', // 6to4
    'http://[2001::1]/', // Teredo
    'http://[100::1]/',
    'http://[::ffff:192.168.1.1]/',
    'http://2130706433/', // decimal 127.0.0.1, normalised by URL
    'http://127.1/',
  ])('refuses %s', (url) => {
    expect(isPrivateUrl(url)).toBe(true);
  });

  it.each([
    'http://8.8.8.8/',
    'http://93.184.216.34/',
    'http://[2606:4700:4700::1111]/',
    'http://[::ffff:8.8.8.8]/',
    'http://[64:ff9b::808:808]/', // NAT64 of a public IPv4
    'https://example.com/hook',
  ])('allows %s', (url) => {
    expect(isPrivateUrl(url)).toBe(false);
  });

  it('classifies bare addresses', () => {
    expect(isPublicUnicastIp('1.1.1.1')).toBe(true);
    expect(isPublicUnicastIp('100.64.0.1')).toBe(false);
    expect(isPublicUnicastIp('fe80::1%eth0')).toBe(false);
    expect(isPublicUnicastIp('not-an-ip')).toBe(false);
  });

  it('keeps the bypass list working', () => {
    expect(isWebhookUrlAllowed('http://127.0.0.1:5678/hook', new Set(['127.0.0.1']))).toBe(true);
    expect(isWebhookUrlAllowed('http://198.18.0.1/hook', new Set())).toBe(false);
  });
});

describe('buildWebhookRequestHeaders', () => {
  it('sends the plain secret by default, beside the signature', () => {
    const headers = buildWebhookRequestHeaders({ secret: 's3cret', bodyText: '{}', isSignedOnly: false });

    expect(headers['X-Documenso-Secret']).toBe('s3cret');
    expect(Object.keys(headers).some((key) => key.toLowerCase().includes('signature'))).toBe(true);
  });

  it('drops the plain secret when signed-only is on', () => {
    const headers = buildWebhookRequestHeaders({ secret: 's3cret', bodyText: '{}', isSignedOnly: true });

    expect(headers['X-Documenso-Secret']).toBeUndefined();
    expect(JSON.stringify(headers)).not.toContain('s3cret');
    expect(Object.keys(headers).some((key) => key.toLowerCase().includes('signature'))).toBe(true);
  });
});

describe('executeWebhookCall: refusals are final', () => {
  it('marks a call to a private address final, without connecting', async () => {
    const { executeWebhookCall } = await import('./execute-webhook-call');

    const result = await executeWebhookCall({ url: 'http://198.18.0.1/hook', body: {}, secret: 's' });

    expect(result).toMatchObject({ success: false, isFinal: true, responseCode: 0 });
  });
});
