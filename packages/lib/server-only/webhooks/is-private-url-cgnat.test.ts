import { describe, expect, it, vi } from 'vitest';

import { assertNotPrivateUrl } from './assert-webhook-url';
import { isPrivateUrl } from './is-private-url';
import { isWebhookUrlAllowed, parseWebhookSsrfBypassHosts } from './webhook-url-rule';

describe('100.64.0.0/10 (carrier-grade NAT, Tailscale)', () => {
  it.each(['http://100.64.0.1', 'http://100.100.46.56:3002/', 'http://100.127.255.254/hook'])('blocks %s', (url) => {
    expect(isPrivateUrl(url)).toBe(true);
  });

  it.each(['http://100.63.255.255', 'http://100.128.0.1', 'http://100.1.2.3'])('leaves %s alone', (url) => {
    expect(isPrivateUrl(url)).toBe(false);
  });

  it('blocks the IPv4-mapped IPv6 forms', () => {
    expect(isPrivateUrl('http://[::ffff:100.64.0.1]/')).toBe(true);
    // new URL() rewrites the dotted form to hex: ::ffff:6440:1.
    expect(isPrivateUrl('http://[::ffff:6440:1]/')).toBe(true);
    expect(isPrivateUrl('http://[::ffff:647f:ffff]/')).toBe(true);
    expect(isPrivateUrl('http://[::ffff:6480:1]/')).toBe(false);
  });

  it('blocks a public name that resolves into the range', async () => {
    const lookup = vi.fn().mockResolvedValue([{ address: '100.88.1.2', family: 4 }]);

    await expect(assertNotPrivateUrl('https://n8n.example.com/hook', { lookup })).rejects.toThrow('private network');
  });

  it('still allows a listed host', () => {
    const hosts = parseWebhookSsrfBypassHosts('100.100.46.56');

    expect(isWebhookUrlAllowed('http://100.100.46.56:5678/webhook', hosts)).toBe(true);
    expect(isWebhookUrlAllowed('http://100.100.46.57:5678/webhook', hosts)).toBe(false);
  });
});
