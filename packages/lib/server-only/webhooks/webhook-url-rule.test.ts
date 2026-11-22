import { afterEach, describe, expect, it, vi } from 'vitest';

import { isHostInWebhookSsrfBypassList, isWebhookUrlAllowed, parseWebhookSsrfBypassHosts } from './webhook-url-rule';

describe('parseWebhookSsrfBypassHosts', () => {
  it('lowercases, trims, drops empty entries and trailing dots', () => {
    expect([...parseWebhookSsrfBypassHosts(' N8N.internal., ,10.0.0.12,')]).toEqual(['n8n.internal', '10.0.0.12']);
    expect(parseWebhookSsrfBypassHosts(undefined).size).toBe(0);
  });
});

describe('isWebhookUrlAllowed', () => {
  const hosts = parseWebhookSsrfBypassHosts('n8n.internal,10.0.0.12,::1');

  it('keeps the default protection when nothing is listed', () => {
    const none = new Set<string>();

    expect(isWebhookUrlAllowed('http://localhost:5678/webhook', none)).toBe(false);
    expect(isWebhookUrlAllowed('http://10.0.0.12/hook', none)).toBe(false);
    expect(isWebhookUrlAllowed('http://169.254.169.254/latest', none)).toBe(false);
    expect(isWebhookUrlAllowed('https://hooks.zapier.com/hooks/catch/1/abc', none)).toBe(true);
  });

  it('allows exactly the listed hosts', () => {
    expect(isWebhookUrlAllowed('http://10.0.0.12:5678/webhook/x', hosts)).toBe(true);
    expect(isWebhookUrlAllowed('http://[::1]:5678/webhook/x', hosts)).toBe(true);
    expect(isHostInWebhookSsrfBypassList('http://N8N.INTERNAL./x', hosts)).toBe(true);
  });

  it('still refuses private hosts that are not listed', () => {
    expect(isWebhookUrlAllowed('http://10.0.0.13/hook', hosts)).toBe(false);
    expect(isWebhookUrlAllowed('http://127.0.0.1/hook', hosts)).toBe(false);
    expect(isWebhookUrlAllowed('http://localhost/hook', hosts)).toBe(false);
  });
});

describe('form and delivery agree', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('saves exactly the private hosts the delivery check lets through', async () => {
    vi.stubEnv('NEXT_PRIVATE_WEBHOOK_SSRF_BYPASS_HOSTS', '10.0.0.12');
    vi.resetModules();

    const { assertWebhookUrlAllowed } = await import('./webhook-url-rule');
    const { assertNotPrivateUrl } = await import('./assert-webhook-url');

    const noLookup = vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);

    for (const url of [
      'http://10.0.0.12:5678/webhook',
      'http://10.0.0.13:5678/webhook',
      'http://127.0.0.1/x',
      'http://100.64.0.9/x',
      'https://hooks.zapier.com/x',
    ]) {
      const isSaveAllowed = (() => {
        try {
          assertWebhookUrlAllowed(url);
          return true;
        } catch {
          return false;
        }
      })();
      const isDeliveryAllowed = await assertNotPrivateUrl(url, { lookup: noLookup }).then(
        () => true,
        () => false,
      );

      expect({ url, isSaveAllowed }).toEqual({ url, isSaveAllowed: isDeliveryAllowed });
    }

    expect(() => assertWebhookUrlAllowed('http://10.0.0.13:5678/webhook')).toThrow('private network');
  });
});
