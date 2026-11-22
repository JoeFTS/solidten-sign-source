import { loadContentImageBytes } from '../data-content/load-content-images';
import type { generatePartialSignedPdf } from '../pdf/generate-partial-signed-pdf';
import { heavyPdfQueue } from '../pdf/heavy-pdf-queue';
import type { TSealPdfOptions } from '../pdf/seal-pdf-bytes';
import { SEAL_FILES, type TTextBox } from './pdf-operations';
import { runPdfOperationIsolated } from './run-pdf-operation';

declare global {
  // eslint-disable-next-line no-var
  var __solidten_pdf_ingest_chain__: Promise<unknown> | undefined;
}

/**
 * Solid Ten (AUD-2): uploaded PDF bytes are parsed in the memory-capped PDF child at EVERY size,
 * inside the heavy-PDF queue. The compressed file size says nothing about the work: a 65 KB file
 * can inflate to 64 MiB and abort the app's heap. A child that dies gives the plain 422
 * (DOCUMENT_TOO_COMPLEX); the app keeps running.
 *
 * - The queue slot is re-entrant: a caller that already holds it (a large create holds it for its
 *   transaction too, runHeavyPdfWork) runs at once.
 * - Inside a slot the files of one request run one at a time (one child per process), so N files
 *   of one request cannot start N children at once.
 * - The cost is one child start per upload (lastStartupMs in /api/health detail).
 */
const runInPdfChild = async <T>(work: () => Promise<T>, { waitForTurn = false } = {}): Promise<T> =>
  await heavyPdfQueue.run(
    async () => {
      const previous = globalThis.__solidten_pdf_ingest_chain__ ?? Promise.resolve();
      const current = previous.catch(() => undefined).then(work);

      globalThis.__solidten_pdf_ingest_chain__ = current.catch(() => undefined);

      return await current;
    },
    { waitForTurn },
  );

const runIngestInChild = runInPdfChild;

/** Normalise an uploaded PDF in the PDF child (run-pdf-operation.ts). */
export const normalizePdfIsolated = async (
  pdf: Buffer,
  options: { flattenForm?: boolean; formValues?: Record<string, string | number | boolean> | null } = {},
) => {
  const { pdf: normalized, pageCount } = await runIngestInChild(
    async () => await runPdfOperationIsolated('normalize', pdf, options),
  );

  return { pdf: normalized, pageCount };
};

/**
 * Form values, normalisation and placeholder extraction for a new envelope item, in the PDF child.
 */
export const prepareUploadedPdfIsolated = async (
  pdf: Buffer,
  options: { flattenForm: boolean; formValues?: Record<string, string | number | boolean> | null },
) => {
  const result = await runIngestInChild(async () => await runPdfOperationIsolated('prepare-upload', pdf, options));

  return { cleanedPdf: result.pdf, placeholders: result.placeholders ?? [], pageCount: result.pageCount };
};

/**
 * The last page's size (seal certificate pages), in the PDF child at every size (AUD-2 follow-up).
 * Runs in background jobs: waits for its turn in the queue.
 */
export const getLastPageSizeIsolated = async (pdf: Uint8Array) => {
  const { pageSize } = await runInPdfChild(
    async () => await runPdfOperationIsolated('page-size', Buffer.from(pdf), {}),
    { waitForTurn: true },
  );

  if (!pageSize) {
    throw new Error('The PDF child did not return the page size');
  }

  return pageSize;
};

/**
 * The PDF part of a seal (seal-pdf-bytes.ts), in a child for a large document. Field and envelope
 * data go to the child as JSON (dates and decimals as text; the insertion code reads them with
 * Number()), the certificate and audit pages and content images as temp files.
 */
export const sealPdfIsolated = async (input: {
  options: TSealPdfOptions;
  pdfData: Uint8Array;
  certificatePdf: Uint8Array | null;
  auditLogPdf: Uint8Array | null;
  contentImageBytes: ReadonlyMap<string, Uint8Array>;
}): Promise<Uint8Array> => {
  const extraFiles = new Map<string, Uint8Array>();

  if (input.certificatePdf) {
    extraFiles.set(SEAL_FILES.certificate, input.certificatePdf);
  }

  if (input.auditLogPdf) {
    extraFiles.set(SEAL_FILES.auditLog, input.auditLogPdf);
  }

  for (const [id, bytes] of input.contentImageBytes) {
    extraFiles.set(SEAL_FILES.image(id), bytes);
  }

  // A plain JSON copy: what the child receives, also when it runs here as a fallback.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const seal = JSON.parse(JSON.stringify(input.options)) as TSealPdfOptions;

  // Solid Ten (AUD-2 follow-up): in the child at every size; a background job waits its turn.
  const { pdf } = await runInPdfChild(
    async () =>
      await runPdfOperationIsolated(
        'seal-pdf',
        Buffer.from(input.pdfData),
        { seal, imageIds: [...input.contentImageBytes.keys()] },
        { extraFiles },
      ),
    { waitForTurn: true },
  );

  return pdf;
};

/**
 * Solid Ten (AUD-2 follow-up): page count of PDF bytes about to be stored, read in the PDF child.
 * Refuses an unreadable or encrypted file (INVALID_DOCUMENT_FILE).
 */
export const inspectPdfIsolated = async (pdf: Uint8Array) => {
  const { pageCount } = await runInPdfChild(
    async () => await runPdfOperationIsolated('inspect', Buffer.from(pdf), {}),
    { waitForTurn: true },
  );

  return { pageCount };
};

/** Where each needle occurs in the PDF, and its page sizes (placeholder fields), in the PDF child. */
export const findTextInPdfIsolated = async (pdf: Uint8Array, needles: string[]) => {
  const result = await runInPdfChild(
    async () => await runPdfOperationIsolated('find-text', Buffer.from(pdf), { needles }),
  );

  return { pages: result.pages ?? [], textMatches: result.textMatches ?? {} };
};

/** White boxes over the given regions, in the PDF child. */
export const whiteoutRegionsIsolated = async (
  pdf: Uint8Array,
  regions: Array<{ pageIndex: number; bbox: TTextBox }>,
) => {
  const { pdf: output } = await runInPdfChild(
    async () => await runPdfOperationIsolated('whiteout', Buffer.from(pdf), { regions }),
  );

  return output;
};

/**
 * The partially signed preview, or the authored contents burned in (generate-partial-signed-pdf.ts),
 * in the PDF child. Content images are loaded here by their data content ids and go as temp files;
 * fields and contents go as JSON (decimals as text; the insertion code reads them with Number()).
 */
export const generatePartialSignedPdfIsolated = async ({
  pdfData,
  fields,
  contents = [],
}: Omit<Parameters<typeof generatePartialSignedPdf>[0], 'images'>) => {
  const imageBytes = await loadContentImageBytes(contents);
  const extraFiles = new Map<string, Uint8Array>();

  for (const [id, bytes] of imageBytes) {
    extraFiles.set(SEAL_FILES.image(id), bytes);
  }

  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const json = JSON.parse(JSON.stringify({ fields, contents })) as { fields: typeof fields; contents: typeof contents };

  const { pdf } = await runInPdfChild(
    async () =>
      await runPdfOperationIsolated(
        'partial-signed',
        Buffer.from(pdfData),
        { fields: json.fields, contents: json.contents, imageIds: [...imageBytes.keys()] },
        { extraFiles },
      ),
  );

  return pdf;
};

/** Page images of a PDF (pdf-to-images.ts), rendered in the PDF child. */
export const pdfToImagesIsolated = async (pdf: Uint8Array, options: { scale?: number } = {}) => {
  const result = await runInPdfChild(
    async () => await runPdfOperationIsolated('page-images', Buffer.from(pdf), { scale: options.scale }),
  );

  return (result.images ?? []).map(({ offset, length, ...image }) => ({
    ...image,
    image: result.pdf.subarray(offset, offset + length),
  }));
};
