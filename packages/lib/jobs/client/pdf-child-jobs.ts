/**
 * Solid Ten: jobs whose heavy PDF work runs in a PDF child process (LD3-H1, LD3-M1).
 *
 * Sealing a large document is the heaviest PDF work the app does. The seal job runs in the app
 * (it needs the database) and holds the heavy-PDF queue slot; its PDF part (decorate, append the
 * certificate and audit pages, sign) runs in a PDF child (seal-document.handler.ts,
 * pdf-child/isolated-pdf.ts). The child gets no database URL and no keys (SEC3-M1). A child that
 * dies is a normal job failure (the app keeps running); a child that cannot start runs the PDF part
 * here, as before.
 */
export const PDF_CHILD_JOB_DEFINITION_IDS = new Set(['internal.seal-document']);

export type TPdfChildJob = { jobId: string; definitionId: string; payload: unknown; maxRetries: number };

declare global {
  // eslint-disable-next-line no-var
  var __solidten_in_pdf_child__: boolean | undefined;
}

const getJobPdfBytes = async (definitionId: string, payload: unknown): Promise<number | null> => {
  if (!PDF_CHILD_JOB_DEFINITION_IDS.has(definitionId)) {
    return null;
  }

  const documentId = (payload as { documentId?: unknown } | null)?.documentId;

  if (typeof documentId !== 'number') {
    return null;
  }

  const { getEnvelopeStoredBytes } = await import('../../server-only/email/stored-document-size');
  const { mapDocumentIdToSecondaryId } = await import('../../utils/envelope');

  return await getEnvelopeStoredBytes({ secondaryId: mapDocumentIdToSecondaryId(documentId) });
};

export const runJobMaybeInPdfChild = async (job: TPdfChildJob, runHere: () => Promise<unknown>) => {
  // Already in the child, or not a PDF job: run as usual.
  if (globalThis.__solidten_in_pdf_child__ || !PDF_CHILD_JOB_DEFINITION_IDS.has(job.definitionId)) {
    await runHere();

    return;
  }

  const bytes = await getJobPdfBytes(job.definitionId, job.payload);
  const { HEAVY_PDF_BYTES, runHeavyPdfWork } = await import('../../server-only/pdf/heavy-pdf-queue');

  if (bytes === null || bytes < HEAVY_PDF_BYTES) {
    await runHere();

    return;
  }

  await runHeavyPdfWork(bytes, runHere, { waitForTurn: true });
};
