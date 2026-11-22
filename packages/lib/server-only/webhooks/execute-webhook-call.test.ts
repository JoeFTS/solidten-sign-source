import { describe, expect, it } from 'vitest';

import { executeWebhookCall } from './execute-webhook-call';

describe('executeWebhookCall (retest: a DNS failure lost the webhook)', () => {
  it('retries a host that does not resolve instead of giving up for good', async () => {
    const result = await executeWebhookCall({
      url: 'https://no-such-host.invalid/hook',
      body: { event: 'TEST' },
      secret: null,
    });

    expect(result.success).toBe(false);
    expect(result.isFinal).toBe(false);
  });

  it('still refuses a private address for good', async () => {
    const result = await executeWebhookCall({ url: 'http://10.0.0.1/hook', body: {}, secret: null });

    expect(result).toMatchObject({ success: false, isFinal: true });
  });
});
