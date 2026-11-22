import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { extractPdfPlaceholders, extractPlaceholdersFromPDF } from '../pdf/auto-place-fields';
import type { generatePartialSignedPdf } from '../pdf/generate-partial-signed-pdf';
import { insertFormValuesInPdf } from '../pdf/insert-form-values-in-pdf';
import { normalizePdf } from '../pdf/normalize-pdf';
import type { TSealPdfOptions } from '../pdf/seal-pdf-bytes';
import { writePrivateFile } from './temp-files';

/**
 * Solid Ten: PDF operations that can run in a child process (LD3-H1, LD3-M1).
 *
 * Each one reads its input from a file and writes its output to a file, so large documents never
 * travel through IPC. The same function runs in the child and, as a fallback, in the main process.
 * None of them touches the database (SEC3-M1): the child gets no database URL and no keys.
 */
export type TPdfOperation =
  | {
      kind: 'normalize';
      inputPath: string;
      outputPath: string;
      flattenForm?: boolean;
      // Solid Ten (AUD-5): form values are filled here too, never in the app process.
      formValues?: Record<string, string | number | boolean> | null;
    }
  | {
      kind: 'prepare-upload';
      inputPath: string;
      outputPath: string;
      flattenForm: boolean;
      formValues?: Record<string, string | number | boolean> | null;
    }
  | {
      // The size of the last page (for the certificate and audit pages of a seal).
      kind: 'page-size';
      inputPath: string;
      outputPath: string;
    }
  | {
      // The PDF part of a seal (seal-pdf-bytes.ts). The certificate and audit pages and the
      // content images are extra files next to the input (SEAL_FILES).
      kind: 'seal-pdf';
      inputPath: string;
      outputPath: string;
      seal: TSealPdfOptions;
      imageIds: string[];
    }
  // Solid Ten (AUD-2 follow-up): every other PDF read of the app runs here too.
  | {
      // Page count of a PDF that is about to be stored; refuses an unreadable or encrypted file.
      kind: 'inspect';
      inputPath: string;
      outputPath: string;
    }
  | {
      // Where each text needle occurs (placeholder fields), and the page sizes.
      kind: 'find-text';
      inputPath: string;
      outputPath: string;
      needles: string[];
    }
  | {
      // White boxes over resolved placeholders.
      kind: 'whiteout';
      inputPath: string;
      outputPath: string;
      regions: Array<{ pageIndex: number; bbox: TTextBox }>;
    }
  | {
      // The partially signed preview and the authored contents (generate-partial-signed-pdf.ts).
      // Content images are extra files (SEAL_FILES.image).
      kind: 'partial-signed';
      inputPath: string;
      outputPath: string;
      fields: Parameters<typeof generatePartialSignedPdf>[0]['fields'];
      contents: NonNullable<Parameters<typeof generatePartialSignedPdf>[0]['contents']>;
      imageIds: string[];
    }
  | {
      // Page images (pdf-to-images.ts), written one after another into the output file.
      kind: 'page-images';
      inputPath: string;
      outputPath: string;
      scale?: number;
    };

export type TTextBox = { x: number; y: number; width: number; height: number };

export type TPdfOperationResult = {
  pageCount: number;
  placeholders?: Awaited<ReturnType<typeof extractPdfPlaceholders>>['placeholders'];
  pageSize?: { width: number; height: number };
  pages?: Array<{ width: number; height: number }>;
  textMatches?: Record<string, Array<{ pageIndex: number; bbox: TTextBox }>>;
  images?: Array<{
    pageNumber: number;
    width: number;
    height: number;
    mimeType: string;
    offset: number;
    length: number;
  }>;
};

/** Names of the extra files of a seal, in the operation's temp folder. */
export const SEAL_FILES = {
  certificate: 'certificate.pdf',
  auditLog: 'audit-log.pdf',
  image: (id: string) => `image-${id.replace(/[^\w-]/g, '_')}.bin`,
};

type TFileOperation = TPdfOperation;

/** Omit over each member of the union (a plain Omit would drop the per-kind fields). */
export type TInMemoryOperation = TFileOperation extends infer T
  ? T extends TFileOperation
    ? Omit<T, 'inputPath' | 'outputPath'>
    : never
  : never;

export const runPdfOperation = async (operation: TPdfOperation): Promise<TPdfOperationResult> => {
  const dir = path.dirname(operation.inputPath);
  const extraFiles = new Map<string, Uint8Array>();

  if (operation.kind === 'seal-pdf' || operation.kind === 'partial-signed') {
    const names =
      operation.kind === 'seal-pdf'
        ? [SEAL_FILES.certificate, SEAL_FILES.auditLog, ...operation.imageIds.map(SEAL_FILES.image)]
        : operation.imageIds.map(SEAL_FILES.image);

    for (const name of names) {
      const bytes = await readFile(path.join(dir, name)).catch(() => null);

      if (bytes) {
        extraFiles.set(name, bytes);
      }
    }
  }

  const { pdf, ...result } = await runPdfBytesOperation(operation, await readFile(operation.inputPath), extraFiles);

  await writePrivateFile(operation.outputPath, pdf);

  return result;
};

/**
 * The same work on bytes in memory: used by the file operation above and, when no temp file can
 * be written (a full or read-only temp folder), directly in this process.
 */
export const runPdfBytesOperation = async (
  operation: TInMemoryOperation,
  input: Buffer,
  extraFiles: ReadonlyMap<string, Uint8Array> = new Map(),
): Promise<TPdfOperationResult & { pdf: Buffer }> => {
  // The seal code (signing, image decoding, overlays) is loaded only by the operations that need
  // it, so a child that normalises an upload starts light.
  if (operation.kind === 'page-size') {
    const { getLastPageSize } = await import('../pdf/seal-pdf-bytes');

    return { pdf: Buffer.alloc(0), pageCount: 0, pageSize: await getLastPageSize(input) };
  }

  if (operation.kind === 'seal-pdf') {
    const { sealPdfBytes } = await import('../pdf/seal-pdf-bytes');

    const sealed = await sealPdfBytes({
      options: operation.seal,
      pdfData: input,
      certificatePdf: extraFiles.get(SEAL_FILES.certificate) ?? null,
      auditLogPdf: extraFiles.get(SEAL_FILES.auditLog) ?? null,
      contentImageBytes: new Map(
        operation.imageIds.flatMap((id) => {
          const bytes = extraFiles.get(SEAL_FILES.image(id));

          return bytes ? [[id, bytes] as const] : [];
        }),
      ),
    });

    return { pdf: Buffer.from(sealed), pageCount: 0 };
  }

  if (operation.kind === 'inspect') {
    const { PDF } = await import('@libpdf/core');
    const { AppError } = await import('../../errors/app-error');
    const doc = await PDF.load(new Uint8Array(input)).catch(() => {
      throw new AppError('INVALID_DOCUMENT_FILE');
    });

    if (doc.isEncrypted) {
      throw new AppError('INVALID_DOCUMENT_FILE');
    }

    return { pdf: Buffer.alloc(0), pageCount: doc.getPageCount() };
  }

  if (operation.kind === 'find-text') {
    const { PDF } = await import('@libpdf/core');
    const doc = await PDF.load(new Uint8Array(input));
    const textMatches: NonNullable<TPdfOperationResult['textMatches']> = {};

    for (const needle of operation.needles) {
      textMatches[needle] = doc.findText(needle).map(({ pageIndex, bbox }) => ({
        pageIndex,
        bbox: { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height },
      }));
    }

    const pages = doc.getPages().map((page) => ({ width: page.width, height: page.height }));

    return { pdf: Buffer.alloc(0), pageCount: pages.length, pages, textMatches };
  }

  if (operation.kind === 'whiteout') {
    const { PDF } = await import('@libpdf/core');
    const { whiteoutRegions } = await import('../pdf/auto-place-fields');
    const doc = await PDF.load(new Uint8Array(input));

    whiteoutRegions(doc, operation.regions);

    return { pdf: Buffer.from(await doc.save()), pageCount: doc.getPageCount() };
  }

  if (operation.kind === 'partial-signed') {
    const { generatePartialSignedPdf } = await import('../pdf/generate-partial-signed-pdf');
    const { decodeContentImages } = await import('../pdf/seal-pdf-bytes');
    const imageBytes = new Map(
      operation.imageIds.flatMap((id) => {
        const bytes = extraFiles.get(SEAL_FILES.image(id));

        return bytes ? [[id, bytes] as const] : [];
      }),
    );

    const pdf = await generatePartialSignedPdf({
      pdfData: input,
      fields: operation.fields,
      contents: operation.contents,
      images: decodeContentImages(imageBytes),
    });

    return { pdf: Buffer.from(pdf), pageCount: 0 };
  }

  if (operation.kind === 'page-images') {
    const { pdfToImages } = await import('../ai/pdf-to-images');
    const pageImages = await pdfToImages(new Uint8Array(input), { scale: operation.scale });
    let offset = 0;
    const images = pageImages.map(({ pageNumber, width, height, mimeType, image }) => {
      const entry = { pageNumber, width, height, mimeType, offset, length: image.length };
      offset += image.length;

      return entry;
    });

    return {
      pdf: Buffer.concat(pageImages.map(({ image }) => Buffer.from(image))),
      pageCount: pageImages.length,
      images,
    };
  }

  if (operation.kind === 'normalize') {
    const filled = operation.formValues
      ? await insertFormValuesInPdf({ pdf: input, formValues: operation.formValues })
      : input;
    const normalized = await normalizePdf(filled, { flattenForm: operation.flattenForm });

    // Solid Ten (AUD-2 follow-up): decode every page's content here, under the child's memory cap,
    // as a later placeholder search would. A file that cannot be decoded within the cap kills this
    // child (the caller gets the plain 422) and is never stored.
    await extractPlaceholdersFromPDF(normalized.pdf);

    return { pdf: Buffer.from(normalized.pdf), pageCount: normalized.pageCount };
  }

  let pdf: Buffer = input;

  if (operation.formValues) {
    pdf = await insertFormValuesInPdf({ pdf, formValues: operation.formValues });
  }

  const normalized = await normalizePdf(pdf, { flattenForm: operation.flattenForm });
  const { cleanedPdf, placeholders } = await extractPdfPlaceholders(normalized.pdf);

  return { pdf: Buffer.from(cleanedPdf), pageCount: normalized.pageCount, placeholders };
};
