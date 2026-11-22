import { describe, expect, it } from 'vitest';

import { getBytesFromStoredLength } from './stored-document-size';

describe('stored document size', () => {
  it('reads the byte size of a base64 document from its stored length', () => {
    const bytes = Buffer.alloc(36 * 1024 * 1024 + 2);
    const stored = bytes.toString('base64');

    expect(getBytesFromStoredLength('BYTES_64', stored.length)).toBeGreaterThanOrEqual(bytes.byteLength - 2);
    expect(getBytesFromStoredLength('BYTES_64', stored.length)).toBeLessThanOrEqual(bytes.byteLength + 2);
    expect(getBytesFromStoredLength('BYTES', 1234)).toBe(1234);
  });
});
