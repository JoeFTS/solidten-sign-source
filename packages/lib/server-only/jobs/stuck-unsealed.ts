import { prisma } from '@documenso/prisma';

import { HEAL_SEAL_WINDOW_MS } from '../../jobs/client/heal-unsealed-envelopes';

/**
 * Solid Ten Sign (S-2): documents whose seal failed and that nothing retries any more.
 *
 * PENDING documents (not deleted) where every signer is done or one rejected, the last signature
 * or rejection is older than the seal sweep's window (6 hours), and a seal job FAILED. Only an
 * administrator's "Reseal document" finishes them. A monitor alerts on a value above 0.
 */
export const countStuckUnsealed = async (now = new Date()) => {
  const before = new Date(now.getTime() - HEAL_SEAL_WINDOW_MS);

  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT count(*) AS "count"
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
      AND (SELECT max(r."signedAt") FROM "Recipient" r WHERE r."envelopeId" = e."id") < ${before}
      AND EXISTS (
        SELECT 1 FROM "BackgroundJob" j
        WHERE j."jobId" = 'internal.seal-document'
          AND j."status" = 'FAILED'
          AND j."payload"->>'documentId' = split_part(e."secondaryId", '_', 2)
      )
  `;

  return Number(rows[0]?.count ?? 0);
};
