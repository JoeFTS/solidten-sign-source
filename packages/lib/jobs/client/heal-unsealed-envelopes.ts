import { prisma } from '@documenso/prisma';

import { mapSecondaryIdToDocumentId } from '../../utils/envelope';

/**
 * Solid Ten: self-healing for a completion that never queued its seal (FS2-L6).
 *
 * The last signer's completion commits the recipient as SIGNED and then queues the seal. When the
 * database restarts in between (failure retest: 1 of 24), the envelope stays PENDING with every
 * signer done and no seal job. The 15-minute seal sweep only looks at signatures older than 15
 * minutes, so the signers waited 15 to 30 minutes for their copy. The job recovery sweep (every
 * minute) now queues the seal itself.
 *
 * An envelope qualifies when it is a PENDING document, not deleted, with at least one recipient,
 * and every recipient SIGNED (or CC) or any recipient REJECTED (as in the seal sweep); its last
 * signature or rejection is more than HEAL_SEAL_AFTER_MS old (a completion in progress is left
 * alone) and less than HEAL_SEAL_WINDOW_MS old (as the seal sweep); and no seal job exists for it
 * in any state (a seal job that runs, waits or failed is handled by job recovery and the seal
 * sweep).
 */
export const HEAL_SEAL_AFTER_MS = 2 * 60_000;
export const HEAL_SEAL_WINDOW_MS = 6 * 60 * 60_000;
export const HEAL_SEAL_BATCH_SIZE = 50;

type TUnsealedEnvelope = { envelopeId: string; secondaryId: string };

export const findUnsealedEnvelopes = async ({
  now = new Date(),
  limit = HEAL_SEAL_BATCH_SIZE,
}: {
  now?: Date;
  limit?: number;
} = {}) => {
  const actedBefore = new Date(now.getTime() - HEAL_SEAL_AFTER_MS);
  const actedAfter = new Date(now.getTime() - HEAL_SEAL_WINDOW_MS);

  return await prisma.$queryRaw<TUnsealedEnvelope[]>`
    SELECT e."id" AS "envelopeId", e."secondaryId"
    FROM "Envelope" e
    WHERE e."status" = 'PENDING'
      AND e."type" = 'DOCUMENT'
      AND e."deletedAt" IS NULL
      AND EXISTS (SELECT 1 FROM "Recipient" r WHERE r."envelopeId" = e."id")
      AND (
        NOT EXISTS (
          SELECT 1 FROM "Recipient" r
          WHERE r."envelopeId" = e."id" AND r."signingStatus" <> 'SIGNED' AND r."role" <> 'CC'
        )
        OR EXISTS (
          SELECT 1 FROM "Recipient" r WHERE r."envelopeId" = e."id" AND r."signingStatus" = 'REJECTED'
        )
      )
      AND (SELECT max(r."signedAt") FROM "Recipient" r WHERE r."envelopeId" = e."id") < ${actedBefore}
      AND (SELECT max(r."signedAt") FROM "Recipient" r WHERE r."envelopeId" = e."id") > ${actedAfter}
      AND NOT EXISTS (
        SELECT 1 FROM "BackgroundJob" j
        WHERE j."jobId" = 'internal.seal-document'
          AND j."payload"->>'documentId' = split_part(e."secondaryId", '_', 2)
      )
    ORDER BY e."id"
    LIMIT ${limit}
  `;
};

/**
 * Queue the missing seals. The trigger id is fixed per envelope, so two app instances healing at
 * once queue one seal.
 */
export const healUnsealedEnvelopes = async (options: Parameters<typeof findUnsealedEnvelopes>[0] = {}) => {
  const unsealed = await findUnsealedEnvelopes(options);

  if (unsealed.length === 0) {
    return [];
  }

  // Loaded on use: the jobs client imports the local provider, which imports this file.
  const { jobs } = await import('../client');

  for (const row of unsealed) {
    console.warn(`[JOBS:recovery] Queuing the missing seal for ${row.envelopeId}`);

    await jobs.triggerJob({
      id: `heal-seal:${row.envelopeId}`,
      name: 'internal.seal-document',
      payload: { documentId: mapSecondaryIdToDocumentId(row.secondaryId) },
    });
  }

  return unsealed.map((row) => row.envelopeId);
};
