import { mkdir, mkdtemp, readdir, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPdfTempDir, getPdfTempRoot, removePdfTempDir, sweepPdfTempFiles, writePrivateFile } from './temp-files';

// Solid Ten: test files run in parallel and share the system temp folder; this file gets its own
// PDF temp root, so counting its folders sees only its own work (getPdfTempRoot reads the setting
// on each call).
let privateTempRoot = '';
const previousTempDir = process.env.NEXT_PRIVATE_ST_PDF_TEMP_DIR;

beforeAll(async () => {
  privateTempRoot = await mkdtemp(path.join(tmpdir(), 'st-pdf-test-'));
  process.env.NEXT_PRIVATE_ST_PDF_TEMP_DIR = privateTempRoot;
});

afterAll(async () => {
  process.env.NEXT_PRIVATE_ST_PDF_TEMP_DIR = previousTempDir;
  await rm(privateTempRoot, { recursive: true, force: true });
});

describe('PDF temp files', () => {
  it('are private: the folders 0700, the files 0600', async () => {
    const dir = await createPdfTempDir();
    const file = path.join(dir, 'input.pdf');

    await writePrivateFile(file, new Uint8Array([1, 2, 3]));

    expect((await stat(getPdfTempRoot())).mode & 0o777).toBe(0o700);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    await removePdfTempDir(dir);
  });

  it('the start sweep removes old leftovers and keeps folders still in use', async () => {
    const old = await createPdfTempDir();
    const young = await createPdfTempDir();
    const longAgo = new Date(Date.now() - 60 * 60_000);

    await mkdir(path.join(old, 'nested'), { recursive: true });
    await utimes(old, longAgo, longAgo);

    await sweepPdfTempFiles({ olderThanMs: 15 * 60_000 });

    const left = await readdir(getPdfTempRoot());

    expect(left).not.toContain(path.basename(old));
    expect(left).toContain(path.basename(young));

    await removePdfTempDir(young);
  });
});
