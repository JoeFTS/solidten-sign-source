import { prisma } from '@documenso/prisma';
import { BackgroundJobStatus, type Prisma, WebhookTriggerEvents } from '@prisma/client';

const EXECUTE_WEBHOOK_JOB_ID = 'internal.execute-webhook';

/**
 * Solid Ten (AUD-32): a purge also removes the copies of the document kept without a foreign key to
 * the envelope. Each is matched on the envelope id (a unique cuid); the legacy numeric payload `id`
 * is shared between documents and templates, so it would also match another envelope's rows.
 *
 * - Webhook call logs of the team: their request body holds comment text, and deleting the row
 *   also ends a pending retry (the sweep reads `nextAttemptAt`; a leased retry finds its call gone).
 * - The public-form submission row (submitter name and email).
 * - Background job payloads: a webhook delivery not yet started is deleted, so its job is dropped
 *   when it is claimed; every other job row of the envelope keeps its row but loses its payload.
 */
export const purgeEnvelopeCopies = async (
  tx: Prisma.TransactionClient,
  { envelopeId, teamId }: { envelopeId: string; teamId: number },
) => {
  await tx.$executeRaw`
    DELETE FROM "WebhookCall" AS call
    USING "Webhook" AS hook
    WHERE call."webhookId" = hook."id"
      AND hook."teamId" = ${teamId}
      AND call."requestBody" -> 'payload' ->> 'envelopeId' = ${envelopeId}`;

  await tx.stPublicFormSubmission.deleteMany({ where: { envelopeId } });

  await tx.$executeRaw`
    DELETE FROM "BackgroundJob"
    WHERE "jobId" = ${EXECUTE_WEBHOOK_JOB_ID}
      AND "status" = ${BackgroundJobStatus.PENDING}::"BackgroundJobStatus"
      AND "payload" -> 'data' ->> 'envelopeId' = ${envelopeId}`;

  await tx.$executeRaw`
    UPDATE "BackgroundJob"
    SET "payload" = NULL
    WHERE "payload" -> 'data' ->> 'envelopeId' = ${envelopeId}
       OR "payload" ->> 'envelopeId' = ${envelopeId}`;
};

/**
 * Solid Ten (AUD-32): a comment webhook queued before its document was purged is not delivered after
 * the purge, so the comment text does not leave the app (or land in a new call log) again.
 */
export const isWebhookForPurgedComment = async (event: WebhookTriggerEvents, data: unknown) => {
  if (event !== WebhookTriggerEvents.DOCUMENT_COMMENT_CREATED) {
    return false;
  }

  const envelopeId =
    typeof data === 'object' && data !== null && 'envelopeId' in data
      ? (data as { envelopeId: unknown }).envelopeId
      : null;

  if (typeof envelopeId !== 'string') {
    return false;
  }

  const envelope = await prisma.envelope.findUnique({ where: { id: envelopeId }, select: { id: true } });

  return envelope === null;
};
