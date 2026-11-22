import { describe, expect, it } from 'vitest';

import { isAssistantSigningOrderValid } from './assert-assistant-signing-order';

describe('assistant signing order (AUD-C12)', () => {
  it('refuses an assistant without sequential signing', () => {
    expect(
      isAssistantSigningOrderValid({ signingOrder: 'PARALLEL', signatureLevel: 'SES', roles: ['ASSISTANT'] }),
    ).toBe(false);
    expect(
      isAssistantSigningOrderValid({ signingOrder: null, signatureLevel: 'SES', roles: ['SIGNER', 'ASSISTANT'] }),
    ).toBe(false);
  });

  it('allows an assistant with sequential signing, and on TSP envelopes', () => {
    expect(
      isAssistantSigningOrderValid({ signingOrder: 'SEQUENTIAL', signatureLevel: 'SES', roles: ['ASSISTANT'] }),
    ).toBe(true);
    expect(
      isAssistantSigningOrderValid({ signingOrder: 'PARALLEL', signatureLevel: 'AES', roles: ['ASSISTANT'] }),
    ).toBe(true);
  });

  it('allows any order without an assistant', () => {
    expect(
      isAssistantSigningOrderValid({ signingOrder: 'PARALLEL', signatureLevel: 'SES', roles: ['SIGNER', 'CC'] }),
    ).toBe(true);
  });
});
