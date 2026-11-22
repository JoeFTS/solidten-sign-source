import { prisma } from '@documenso/prisma';
import { Prisma } from '@prisma/client';

import { AppError } from '../../errors/app-error';
import { env } from '../../utils/env';
import { getDailyQuotaBucket } from '../rate-limit/daily-quota';

/**
 * Solid Ten: heavy PDF work that falls back to the app process (LD4-L1).
 *
 * When the PDF child cannot be used (no child entry, a child that cannot start, a temp folder that
 * cannot be written) the work runs in the app process: the app stays available, but without the
 * child's memory limit, and before only a log line said so. Now each fallback:
 * - is counted with its time and reason (the /api/health detail: pdfChild.fallbacks,
 *   lastFallbackAt, lastFallbackReason; the public status stays "ok");
 * - the first one of a UTC day sends one notice to the server operators (the server-notice path of
 *   the daily caps);
 * - with NEXT_PRIVATE_ST_PDF_CHILD_REQUIRED=true it is refused instead: 503 "Document processing is
 *   unavailable right now". Uploads reach the child at every size (AUD-2); the seal and page-size
 *   steps only from HEAVY_PDF_BYTES (2 MB), so for them the setting applies to large files only.
 */
export const PDF_PROCESSING_UNAVAILABLE_CODE = 'PDF_PROCESSING_UNAVAILABLE';
export const PDF_PROCESSING_UNAVAILABLE_MESSAGE =
  'Document processing is unavailable right now. Try again in a few minutes.';

const FALLBACK_NOTICE_ACTION = 'st.pdf-child-fallback';

export type TPdfChildFallbackStats = {
  fallbacks: number;
  lastFallbackAt: string | null;
  lastFallbackReason: string | null;
  refusals: number;
};

export const isPdfChildRequired = () => env('NEXT_PRIVATE_ST_PDF_CHILD_REQUIRED') === 'true';

export const createPdfProcessingUnavailableError = () =>
  new AppError(PDF_PROCESSING_UNAVAILABLE_CODE, {
    message: PDF_PROCESSING_UNAVAILABLE_MESSAGE,
    userMessage: PDF_PROCESSING_UNAVAILABLE_MESSAGE,
    statusCode: 503,
    headers: { 'Retry-After': '60' },
  });

/** The first fallback of the UTC day: one notice to the server operators. Never throws. */
const noticeOncePerDay = async (reason: string) => {
  try {
    await prisma.rateLimit.create({
      data: { key: 'pdf-child', action: FALLBACK_NOTICE_ACTION, bucket: getDailyQuotaBucket(), count: 1 },
    });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) {
      console.error('[PDF]: Could not record the PDF child fallback for the daily notice', error);
    }

    return;
  }

  try {
    const { notifyOperatorsOfPdfChildFallback } = await import('./pdf-child-fallback-notice');

    await notifyOperatorsOfPdfChildFallback(reason);
  } catch (error) {
    console.error('[PDF]: Could not email the operators about the PDF child fallback', error);
  }
};

/**
 * Heavy PDF work is about to run in the app process instead of a child, for `reason`. Throws the
 * 503 when the child is required; else counts it and sends the daily notice (in the background).
 */
export const fallBackToAppProcess = (
  stats: TPdfChildFallbackStats,
  reason: string,
  error?: unknown,
  { notify = noticeOncePerDay }: { notify?: (reason: string) => Promise<void> } = {},
) => {
  if (isPdfChildRequired()) {
    stats.refusals++;
    console.error(`[PDF]: ${reason}; refused (NEXT_PRIVATE_ST_PDF_CHILD_REQUIRED=true)`, ...(error ? [error] : []));

    throw createPdfProcessingUnavailableError();
  }

  stats.fallbacks++;
  stats.lastFallbackAt = new Date().toISOString();
  stats.lastFallbackReason = reason;
  console.warn(`[PDF]: ${reason}; running in this process`, ...(error ? [error] : []));

  void notify(reason);
};
