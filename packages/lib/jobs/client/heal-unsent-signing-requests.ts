import { prisma } from '@documenso/prisma';

import { mapSecondaryIdToDocumentId } from '../../utils/envelope';

/**
 * Solid Ten: self-healing for signing requests that were never queued.
 *
 * `sendDocument` can fail after its transaction committed (a timeout under load, a crash): the
 * envelope is PENDING with DOCUMENT_SENT written, but the recipients are NOT_SENT and no
 * signing-email job exists. Calling distribute again fixed it by hand. The recovery sweep now
 * finds such recipients and queues the email itself.
 *
 * A recipient qualifies when:
 * - the envelope is a PENDING document, not deleted, sent by email, and DOCUMENT_SENT was written
 *   more than HEAL_AFTER_MS ago (a send in progress is left alone) and less than HEAL_WINDOW_MS
 *   ago (never mail about old documents in bulk);
 * - the recipient signs, approves, views or assists (not CC), has not signed, is NOT_SENT, and is
 *   not marked "not delivered";
 * - it is their turn: in a sequential document, theirs is the lowest signing order still open;
 * - no signing-email job exists for them in any state (a job that ran and chose not to send,
 *   for example with signing emails turned off, is final).
 */
export const HEAL_AFTER_MS = 5 * 60_000;
export const HEAL_WINDOW_MS = 7 * 24 * 60 * 60_000;
export const HEAL_BATCH_SIZE = 50;

export type TUnsentSigningRequest = {
  recipientId: number;
  envelopeId: string;
  secondaryId: string;
  userId: number;
};

export const findUnsentSigningRequests = async ({
  now = new Date(),
  envelopeIds,
  limit = HEAL_BATCH_SIZE,
}: {
  now?: Date;
  envelopeIds?: string[];
  limit?: number;
} = {}) => {
  const sentBefore = new Date(now.getTime() - HEAL_AFTER_MS);
  const sentAfter = new Date(now.getTime() - HEAL_WINDOW_MS);
  const scope = envelopeIds ?? null;

  return await prisma.$queryRaw<TUnsentSigningRequest[]>`
    SELECT r."id" AS "recipientId", e."id" AS "envelopeId", e."secondaryId", e."userId"
    FROM "Recipient" r
    JOIN "Envelope" e ON e."id" = r."envelopeId"
    JOIN "DocumentMeta" m ON m."id" = e."documentMetaId"
    WHERE e."status" = 'PENDING'
      AND e."type" = 'DOCUMENT'
      AND e."deletedAt" IS NULL
      AND m."distributionMethod" = 'EMAIL'
      AND r."role" <> 'CC'
      AND r."signingStatus" = 'NOT_SIGNED'
      AND r."sendStatus" = 'NOT_SENT'
      AND r."deliveryFailedAt" IS NULL
      AND (${scope}::text[] IS NULL OR e."id" = ANY(${scope}::text[]))
      AND EXISTS (
        SELECT 1 FROM "DocumentAuditLog" a
        WHERE a."envelopeId" = e."id" AND a."type" = 'DOCUMENT_SENT'
          AND a."createdAt" < ${sentBefore} AND a."createdAt" > ${sentAfter}
      )
      AND (
        m."signingOrder" <> 'SEQUENTIAL'
        OR r."signingOrder" IS NOT DISTINCT FROM (
          SELECT min(r2."signingOrder") FROM "Recipient" r2
          WHERE r2."envelopeId" = e."id" AND r2."role" <> 'CC' AND r2."signingStatus" = 'NOT_SIGNED'
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM "BackgroundJob" j
        WHERE j."jobId" = 'send.signing.requested.email'
          AND j."payload"->>'recipientId' = r."id"::text
      )
    ORDER BY r."id"
    LIMIT ${limit}
  `;
};

/**
 * Queue the missing signing emails. The trigger id is fixed per recipient, so two app instances
 * healing at once queue one email.
 */
export const healUnsentSigningRequests = async (
  options: Parameters<typeof findUnsentSigningRequests>[0] = {},
): Promise<number[]> => {
  const unsent = await findUnsentSigningRequests(options);

  if (unsent.length === 0) {
    return [];
  }

  // Loaded on use: the jobs client imports the local provider, which imports this file.
  const { jobs } = await import('../client');

  for (const row of unsent) {
    console.warn(
      `[JOBS:recovery] Queuing the missing signing request for recipient ${row.recipientId} (${row.envelopeId})`,
    );

    await jobs.triggerJob({
      id: `heal-signing-request:${row.recipientId}`,
      name: 'send.signing.requested.email',
      payload: {
        userId: row.userId,
        documentId: mapSecondaryIdToDocumentId(row.secondaryId),
        recipientId: row.recipientId,
      },
    });
  }

  return unsent.map((row) => row.recipientId);
};
