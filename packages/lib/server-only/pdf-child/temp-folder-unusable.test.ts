import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getPdfChildStats, runPdfOperationIsolated } from './run-pdf-operation';
import { getPdfTempRoot } from './temp-files';

const examplePdf = async () => await readFile(path.join(__dirname, '../../../../assets/example.pdf'));
const fakeChild = path.join(__dirname, '__fixtures__/fake-child.mjs');
const commandFor = (mode: string) => ({ modulePath: fakeChild, args: [mode], execArgv: ['--max-old-space-size=64'] });

describe('a PDF temp folder that cannot be written', () => {
  let folder: string;
  const previous = process.env.NEXT_PRIVATE_ST_PDF_TEMP_DIR;

  beforeEach(async () => {
    folder = await mkdtemp(path.join(tmpdir(), 'st-pdf-temp-test-'));
    process.env.NEXT_PRIVATE_ST_PDF_TEMP_DIR = folder;
  });

  afterEach(async () => {
    process.env.NEXT_PRIVATE_ST_PDF_TEMP_DIR = previous;
    await chmod(folder, 0o700).catch(() => {});
    await rm(folder, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('uses NEXT_PRIVATE_ST_PDF_TEMP_DIR when set', () => {
    expect(getPdfTempRoot()).toBe(path.join(folder, 'solidten-pdf'));
  });

  it('read-only: the work runs in memory in this process, with one clear log line, and does not hang', async () => {
    await chmod(folder, 0o500);
    const logged = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const before = getPdfChildStats().tempFolderFailures;

    const result = await runPdfOperationIsolated('normalize', await examplePdf(), {}, { command: commandFor('ok') });

    expect(result.pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(result.pageCount).toBeGreaterThan(0);
    expect(getPdfChildStats().tempFolderFailures).toBe(before + 1);
    expect(logged).toHaveBeenCalledWith(
      expect.stringMatching(/Cannot write PDF temp files in .*st-pdf-temp-test-.* \((EACCES|EPERM|EROFS)\)/),
    );
  }, 30_000);

  it('full while the child writes its output: the work runs in memory instead', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const before = getPdfChildStats().tempFolderFailures;

    const result = await runPdfOperationIsolated(
      'prepare-upload',
      await examplePdf(),
      { flattenForm: false },
      {
        command: commandFor('enospc'),
      },
    );

    expect(result.pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(getPdfChildStats().tempFolderFailures).toBe(before + 1);
  }, 30_000);
});
