import { base64 } from '@scure/base';
import { describe, expect, it } from 'vitest';

import { decodeBase64, encodeBase64 } from './base64';

describe('base64 for document bytes (LD3-H1, LD3-M1)', () => {
  it('gives the same text as @scure/base, both ways', () => {
    const bytes = new Uint8Array(100_003).map((_, index) => (index * 7) % 256);
    const text = base64.encode(bytes);

    expect(encodeBase64(bytes)).toBe(text);
    expect(Buffer.from(decodeBase64(text)).equals(Buffer.from(bytes))).toBe(true);
  });

  it('encodes and decodes a 15 MB document quickly and without a large memory jump', () => {
    const bytes = new Uint8Array(15 * 1024 * 1024).map((_, index) => index % 251);
    const rssBefore = process.memoryUsage().rss;
    const started = Date.now();

    const text = encodeBase64(bytes);
    const decoded = decodeBase64(text);

    const elapsedMs = Date.now() - started;
    const rssGrowthMb = (process.memoryUsage().rss - rssBefore) / (1024 * 1024);

    expect(decoded.byteLength).toBe(bytes.byteLength);
    // The pure-JavaScript fallback took about 2.2 s and about 1 GB here.
    expect(elapsedMs).toBeLessThan(400);
    expect(rssGrowthMb).toBeLessThan(200);
  });
});
