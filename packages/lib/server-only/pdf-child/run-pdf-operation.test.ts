import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  createDocumentTooComplexError,
  getPdfChildStats,
  runInChild,
  runPdfOperationIsolated,
} from './run-pdf-operation';
import { getPdfTempRoot } from './temp-files';

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

const tempFolders = async () => (await readdir(getPdfTempRoot()).catch(() => [] as string[])).length;

const fakeChild = path.join(__dirname, '__fixtures__/fake-child.mjs');
const commandFor = (mode: string) => ({ modulePath: fakeChild, args: [mode], execArgv: ['--max-old-space-size=64'] });
const input = Buffer.from('%PDF-1.7 fake');

const operation = { kind: 'normalize' as const, inputPath: '/nonexistent', outputPath: '/nonexistent' };

describe('heavy PDF work in a child process (LD3-H1, LD3-M1)', () => {
  it('runs the operation in another process and returns its output by file', async () => {
    const command = commandFor('ok');
    const result = await runPdfOperationIsolated('normalize', input, {}, { command });

    expect(result.pageCount).toBe(7);
    expect(result.pdf.equals(input)).toBe(true);
    expect((result as unknown as { pid?: number }).pid).not.toBe(process.pid);
  });

  it('a child that dies gives DOCUMENT_TOO_COMPLEX, and this process carries on', async () => {
    const command = commandFor('crash');
    const foldersBefore = await tempFolders();

    await expect(runPdfOperationIsolated('normalize', input, {}, { command })).rejects.toMatchObject({
      code: 'DOCUMENT_TOO_COMPLEX',
      statusCode: 422,
      userMessage: 'This document is too large or complex to process.',
    });

    // The document does not stay behind in a temp folder.
    expect(await tempFolders()).toBe(foldersBefore);
  });

  it('a child that cannot start falls back to this process', async () => {
    const command = commandFor('no-start');
    const before = getPdfChildStats().fallbacks;

    // The in-process normalisation then refuses the fake bytes as an invalid PDF.
    await expect(runPdfOperationIsolated('normalize', input, {}, { command })).rejects.toMatchObject({
      code: 'INVALID_DOCUMENT_FILE',
    });
    expect(getPdfChildStats().fallbacks).toBe(before + 1);
  });

  it("passes the child's own errors through", async () => {
    const command = commandFor('app-error');
    await expect(runPdfOperationIsolated('normalize', input, {}, { command })).rejects.toMatchObject({
      code: 'INVALID_DOCUMENT_FILE',
    });
  });

  it('stops a child that runs too long', async () => {
    await expect(runInChild(operation, commandFor('hang'), 300)).rejects.toMatchObject({
      code: 'DOCUMENT_TOO_COMPLEX',
    });
  });
});

describe('the 422 of a failed PDF process (LD4-L3)', () => {
  it('says only the plain message; the signal goes to the log', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = createDocumentTooComplexError('the PDF process was stopped (SIGABRT)');

    expect(error.message).toBe('This document is too large or complex to process.');
    expect(error.userMessage).toBe('This document is too large or complex to process.');
    expect(JSON.stringify(error)).not.toMatch(/SIGABRT|PDF process/);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('SIGABRT'));
    logged.mockRestore();
  });
});
