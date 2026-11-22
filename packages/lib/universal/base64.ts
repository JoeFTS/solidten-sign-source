import { base64 } from '@scure/base';

// Kept: other code imports @scure/base's codecs from here.
export * from '@scure/base';

/**
 * Solid Ten: base64 for document bytes (LD3-H1, LD3-M1).
 *
 * @scure/base uses the built-in Uint8Array.toBase64 when the runtime has it; Node 24 does not, so
 * it falls back to pure JavaScript: encoding a 15 MB document took 1.3 s on the main thread and
 * about 1 GB of memory, decoding about 1 s. Node's Buffer does the same in milliseconds with no
 * extra memory, and gives the same text. In a browser (no Buffer) @scure/base is used as before.
 */
const hasBuffer = typeof Buffer !== 'undefined' && typeof Buffer.from === 'function';

export const encodeBase64 = (bytes: Uint8Array): string =>
  hasBuffer ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64') : base64.encode(bytes);

export const decodeBase64 = (text: string): Uint8Array => {
  if (!hasBuffer) {
    return base64.decode(text);
  }

  const buffer = Buffer.from(text, 'base64');

  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
};
