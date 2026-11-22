import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { fallBackToAppProcess } from './pdf-child-fallback';
import { getPdfChildStats, runPdfOperationIsolated } from './run-pdf-operation';

const fakeChild = path.join(__dirname, '__fixtures__/fake-child.mjs');
const noStart = { modulePath: fakeChild, args: ['no-start'], execArgv: ['--max-old-space-size=64'] };
const freshStats = () => ({ fallbacks: 0, lastFallbackAt: null, lastFallbackReason: null, refusals: 0 });

describe('heavy PDF work in the app process instead of a child (LD4-L1)', () => {
  afterEach(() => {
    delete process.env.NEXT_PRIVATE_ST_PDF_CHILD_REQUIRED;
    vi.restoreAllMocks();
  });

  it('is counted with its time and reason, and the daily notice is asked for', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stats = freshStats();
    const notify = vi.fn(async () => {});

    fallBackToAppProcess(stats, 'The PDF child could not start', undefined, { notify });

    expect(stats.fallbacks).toBe(1);
    expect(stats.lastFallbackReason).toBe('The PDF child could not start');
    expect(Date.now() - Date.parse(stats.lastFallbackAt ?? '')).toBeLessThan(5_000);
    expect(notify).toHaveBeenCalledWith('The PDF child could not start');
  });

  it('with NEXT_PRIVATE_ST_PDF_CHILD_REQUIRED=true it is refused with a plain 503, no notice', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.NEXT_PRIVATE_ST_PDF_CHILD_REQUIRED = 'true';
    const stats = freshStats();
    const notify = vi.fn(async () => {});

    expect(() => fallBackToAppProcess(stats, 'No PDF child entry found', undefined, { notify })).toThrow(
      expect.objectContaining({
        code: 'PDF_PROCESSING_UNAVAILABLE',
        statusCode: 503,
        message: 'Document processing is unavailable right now. Try again in a few minutes.',
      }),
    );
    expect(stats).toMatchObject({ fallbacks: 0, refusals: 1 });
    expect(notify).not.toHaveBeenCalled();
  });

  it('a child that cannot start: falls back by default, refused when the child is required', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const input = Buffer.from('%PDF-1.7 fake');
    const before = getPdfChildStats().fallbacks;

    // Fallback: the in-process normalisation then refuses the fake bytes as an invalid PDF.
    await expect(runPdfOperationIsolated('normalize', input, {}, { command: noStart })).rejects.toMatchObject({
      code: 'INVALID_DOCUMENT_FILE',
    });
    expect(getPdfChildStats().fallbacks).toBe(before + 1);
    expect(getPdfChildStats().lastFallbackReason).toBe('The PDF child could not start');

    process.env.NEXT_PRIVATE_ST_PDF_CHILD_REQUIRED = 'true';
    await expect(runPdfOperationIsolated('normalize', input, {}, { command: noStart })).rejects.toMatchObject({
      code: 'PDF_PROCESSING_UNAVAILABLE',
      statusCode: 503,
    });
  });
});
