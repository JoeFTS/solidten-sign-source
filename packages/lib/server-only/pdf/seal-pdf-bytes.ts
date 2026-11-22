import { PDFDocument } from '@cantoo/pdf-lib';
import { signPdf } from '@documenso/signing';
import { Image as SkiaImage } from '@documenso/skia-canvas';
import { PDF } from '@libpdf/core';
import type { Envelope, EnvelopeContent, Field } from '@prisma/client';

import type { ContentImageMap, ContentImageSource } from '../../universal/content-renderer/content-renderer';
import { addRejectionStampToPdf } from './add-rejection-stamp-to-pdf';
import { getLastPageDimensions } from './get-page-size';
import { insertFieldInPDFV1 } from './insert-field-in-pdf-v1';
import { insertPageOverlays } from './insert-page-overlay';
import { legacy_insertFieldInPDF } from './legacy-insert-field-in-pdf';

/**
 * Solid Ten: the PDF part of a seal, on bytes, with no database (SEC3-M1).
 *
 * The seal job used to run whole in the PDF child, so the child needed the database URL and the
 * encryption keys. Now the job runs in the app (database work, certificate and audit pages, saving
 * the file) and only this runs in the child for a large document: flatten, append the certificate
 * and audit pages, insert fields and contents, stamp a rejection, sign. It needs the signing
 * certificate settings and nothing else from the environment. Small documents run it in the app.
 */
export type TSealPdfEnvelope = Pick<Envelope, 'id' | 'title' | 'useLegacyFieldInsertion' | 'internalVersion'>;

export type TSealPdfOptions = {
  envelope: TSealPdfEnvelope;
  fields: Field[];
  contents: EnvelopeContent[];
  isRejected: boolean;
  rejectionReason: string;
};

/** Decoded images by data content id, from their stored bytes. */
export const decodeContentImages = (imageBytes: ReadonlyMap<string, Uint8Array>): ContentImageMap =>
  new Map(
    [...imageBytes].map(
      ([id, bytes]) => [id, new SkiaImage(Buffer.from(bytes)) as unknown as ContentImageSource] as const,
    ),
  );

export const getLastPageSize = async (pdfData: Uint8Array) => getLastPageDimensions(await PDF.load(pdfData));

export const sealPdfBytes = async ({
  options,
  pdfData,
  certificatePdf,
  auditLogPdf,
  contentImageBytes,
}: {
  options: TSealPdfOptions;
  pdfData: Uint8Array;
  certificatePdf: Uint8Array | null;
  auditLogPdf: Uint8Array | null;
  contentImageBytes: ReadonlyMap<string, Uint8Array>;
}): Promise<Uint8Array> => {
  const { envelope, fields, contents, isRejected, rejectionReason } = options;

  let pdfDoc = await PDF.load(pdfData);

  // Normalize and flatten layers that could cause issues with the signature
  pdfDoc.flattenAll();
  // Upgrade to PDF 1.7 for better compatibility with signing
  pdfDoc.upgradeVersion('1.7');

  // Taken before the certificate and audit log pages are appended.
  const documentPageCount = pdfDoc.getPageCount();

  for (const appended of [certificatePdf, auditLogPdf]) {
    if (appended) {
      const appendedDoc = await PDF.load(appended);

      await pdfDoc.copyPagesFrom(
        appendedDoc,
        Array.from({ length: appendedDoc.getPageCount() }, (_, index) => index),
      );
    }
  }

  // Handle V1 and legacy insertions.
  if (envelope.internalVersion === 1) {
    const legacy_pdfLibDoc = await PDFDocument.load(await pdfDoc.save({ useXRefStream: true }));

    for (const field of fields) {
      if (field.inserted) {
        if (envelope.useLegacyFieldInsertion) {
          await legacy_insertFieldInPDF(legacy_pdfLibDoc, field);
        } else {
          await insertFieldInPDFV1(legacy_pdfLibDoc, field);
        }
      }
    }

    // Should never run into issues with this flatten since all
    // arcoFields are created by pdf-lib itself.
    legacy_pdfLibDoc.getForm().flatten();

    await pdfDoc.reload(await legacy_pdfLibDoc.save());
  }

  // Handle V2 envelope insertions.
  if (envelope.internalVersion === 2) {
    await insertPageOverlays({
      pdfDoc,
      fields,
      contents,
      images: decodeContentImages(contentImageBytes),
    });
  }

  // Stamped after the fields and contents so opaque contents cannot hide it.
  if (isRejected) {
    await addRejectionStampToPdf(pdfDoc, rejectionReason, { pageCount: documentPageCount });
  }

  // Re-flatten the form to handle our checkbox and radio fields that
  // create native arcoFields
  pdfDoc.flattenAll();

  pdfDoc = await PDF.load(await pdfDoc.save({ useXRefStream: true }));

  return await signPdf({ pdf: pdfDoc });
};
