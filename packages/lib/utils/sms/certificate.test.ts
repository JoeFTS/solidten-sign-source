import { describe, expect, it } from 'vitest';

import { getFirstSigningLinkDelivery, getSigningLinkChannel } from './certificate';

const at = (iso: string) => ({ createdAt: new Date(iso) });

describe('certificate delivery helpers', () => {
  it('picks the earliest delivery across channels', () => {
    const texted = at('2026-11-01T10:00:00Z');
    const emailed = at('2026-11-01T10:00:05Z');

    expect(getFirstSigningLinkDelivery({ emailed, texted })).toBe(texted);
    expect(getFirstSigningLinkDelivery({ emailed, texted: null })).toBe(emailed);
    expect(getFirstSigningLinkDelivery({ emailed: null })).toBeNull();
  });

  it('names the channel only when a text went out', () => {
    expect(getSigningLinkChannel({ emailed: at('2026-11-01T10:00:00Z') })).toBeNull();
    expect(getSigningLinkChannel({ emailed: null, texted: at('2026-11-01T10:00:00Z') })).toBe('SMS');
    expect(getSigningLinkChannel({ emailed: at('2026-11-01T10:00:00Z'), texted: at('2026-11-01T10:00:00Z') })).toBe(
      'EMAIL_AND_SMS',
    );
  });
});
