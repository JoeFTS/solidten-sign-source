import { z } from 'zod';

import { ZRequestMetadataSchema } from '../../../universal/extract-request-metadata';
import type { JobDefinition } from '../../client/_internal/job';

const SEAL_DOCUMENT_JOB_DEFINITION_ID = 'internal.seal-document';

const SEAL_DOCUMENT_JOB_DEFINITION_SCHEMA = z.object({
  documentId: z.number(),
  sendEmail: z.boolean().optional(),
  isResealing: z.boolean().optional(),
  requestMetadata: ZRequestMetadataSchema.optional(),
});

export type TSealDocumentJobDefinition = z.infer<typeof SEAL_DOCUMENT_JOB_DEFINITION_SCHEMA>;

export const SEAL_DOCUMENT_JOB_DEFINITION = {
  id: SEAL_DOCUMENT_JOB_DEFINITION_ID,
  name: 'Seal Document',
  version: '1.0.0',
  optimizeParallelism: true,
  trigger: {
    name: SEAL_DOCUMENT_JOB_DEFINITION_ID,
    schema: SEAL_DOCUMENT_JOB_DEFINITION_SCHEMA,
  },
  handler: async ({ payload, io }) => {
    const handler = await import('./seal-document.handler');
    const { runHeavyPdfWork } = await import('../../../server-only/pdf/heavy-pdf-queue');
    const { getEnvelopeStoredBytes } = await import('../../../server-only/email/stored-document-size');
    const { mapDocumentIdToSecondaryId } = await import('../../../utils/envelope');

    // Solid Ten: sealing a large document is heavy PDF work; it runs alone among it (LD2-A).
    const bytes = await getEnvelopeStoredBytes({ secondaryId: mapDocumentIdToSecondaryId(payload.documentId) });

    // A job waits for its turn (no 503): a refusal would only use up its retries.
    await runHeavyPdfWork(bytes, async () => await handler.run({ payload, io }), { waitForTurn: true });
  },
} as const satisfies JobDefinition<typeof SEAL_DOCUMENT_JOB_DEFINITION_ID, TSealDocumentJobDefinition>;
