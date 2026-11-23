import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import type { Field } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolvePdfChildCommand, runPdfOperationIsolated } from './run-pdf-operation';

/**
 * Solid Ten (S-1): the real PDF child, as the seal starts it, with the public app URL pointing at
 * an address nothing listens on and the internal URL at a small server that has the fonts. Before
 * the fix the child did not get NEXT_PRIVATE_INTERNAL_WEBAPP_URL, fell back to the public URL and
 * failed with "fetch failed" (V1 fields and the rejection stamp fetch fonts).
 */

const repoRoot = path.resolve(__dirname, '../../../..');
const fontsDir = path.join(repoRoot, 'apps/remix/public/fonts');

const ENV_NAMES = [
  'NEXT_PUBLIC_WEBAPP_URL',
  'NEXT_PRIVATE_INTERNAL_WEBAPP_URL',
  'NEXT_PRIVATE_SIGNING_TRANSPORT',
  'NEXT_PRIVATE_SIGNING_LOCAL_FILE_PATH',
  'NEXT_PRIVATE_SIGNING_LOCAL_FILE_CONTENTS',
  'NEXT_PRIVATE_SIGNING_PASSPHRASE',
] as const;

const previous = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));

let server: Server;
const fontRequests: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const name = path.basename(req.url ?? '');

    fontRequests.push(name);

    readFile(path.join(fontsDir, name))
      .then((bytes) => {
        res.writeHead(200, { 'content-type': 'font/ttf' });
        res.end(bytes);
      })
      .catch(() => {
        res.writeHead(404);
        res.end();
      });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const { port } = server.address() as AddressInfo;

  // Port 9 (discard): nothing listens, as a public address the container cannot reach.
  process.env.NEXT_PUBLIC_WEBAPP_URL = 'http://127.0.0.1:9';
  process.env.NEXT_PRIVATE_INTERNAL_WEBAPP_URL = `http://127.0.0.1:${port}`;
  process.env.NEXT_PRIVATE_SIGNING_TRANSPORT = 'local';
  process.env.NEXT_PRIVATE_SIGNING_LOCAL_FILE_PATH = path.join(repoRoot, 'apps/remix/example/cert.p12');
  delete process.env.NEXT_PRIVATE_SIGNING_LOCAL_FILE_CONTENTS;
  process.env.NEXT_PRIVATE_SIGNING_PASSPHRASE = '';
});

afterAll(async () => {
  for (const name of ENV_NAMES) {
    if (previous[name] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous[name];
    }
  }

  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const nameField = {
  id: 1,
  secondaryId: 'field_1',
  envelopeId: 'envelope_s1',
  envelopeItemId: 'item_s1',
  recipientId: 1,
  type: 'NAME',
  page: 1,
  positionX: 10,
  positionY: 10,
  width: 20,
  height: 5,
  customText: 'Ada Lovelace',
  inserted: true,
  fieldMeta: null,
  signature: null,
} as unknown as Field;

const seal = async (options: { internalVersion: 1 | 2; fields: Field[]; isRejected: boolean }) => {
  const input = await readFile(path.join(repoRoot, 'assets/example.pdf'));

  return await runPdfOperationIsolated('seal-pdf', input, {
    seal: {
      envelope: {
        id: 'envelope_s1',
        title: 'S-1',
        useLegacyFieldInsertion: false,
        internalVersion: options.internalVersion,
      },
      fields: options.fields,
      contents: [],
      isRejected: options.isRejected,
      rejectionReason: options.isRejected ? 'Not for me' : '',
    },
    imageIds: [],
  });
};

describe('the PDF child reaches the app by the internal URL (S-1)', () => {
  it('runs as a real child process here', () => {
    expect(resolvePdfChildCommand()).not.toBeNull();
  });

  it('a V1 document with an inserted field seals', { timeout: 120_000 }, async () => {
    fontRequests.length = 0;

    const result = await seal({ internalVersion: 1, fields: [nameField], isRejected: false });

    expect(result.pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(fontRequests).toEqual(expect.arrayContaining(['caveat.ttf', 'noto-sans.ttf']));
  });

  it('a rejected V2 document gets its stamp and seals', { timeout: 120_000 }, async () => {
    fontRequests.length = 0;

    const result = await seal({ internalVersion: 2, fields: [], isRejected: true });

    expect(result.pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(fontRequests).toContain('noto-sans.ttf');
  });
});
