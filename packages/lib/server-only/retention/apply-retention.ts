import { prisma } from '@documenso/prisma';
import type { Prisma } from '@prisma/client';
import { DocumentDataType, WebhookTriggerEvents } from '@prisma/client';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../types/document-audit-logs';
import { mapEnvelopeToWebhookDocumentPayload, ZWebhookDocumentSchema } from '../../types/webhook-payload';
import { deleteFile } from '../../universal/upload/delete-file';
import { createDocumentAuditLogData } from '../../utils/document-audit-logs';
import { mapSecondaryIdToDocumentId } from '../../utils/envelope';
import { logger } from '../../utils/logger';
import {
  getRetentionCutoff,
  getRetentionStatuses,
  isEnvelopeRetentionEligible,
  planStoredObjectDeletion,
  type TRetentionSettings,
} from '../../utils/retention';
import { deleteEnvelopeComments } from '../envelope-comments/comment-records';
import { getEnvelopeFieldFileDataContentIds } from '../field-file/field-file-access';
import { triggerWebhook } from '../webhooks/trigger/trigger-webhook';
import { purgeEnvelopeCopies } from './purge-envelope-copies';
import { buildPurgeRecordData } from './purge-record';
import { getRetentionPurgeBlock } from './retention-governance';
import { getTeamRetentionSettings, isRetentionDryRun } from './retention-rules';

export const RETENTION_USER_AGENT = 'Solid Ten Sign retention';

export type RetentionOutcome =
  | { result: 'SKIPPED'; reason: string }
  | { result: 'DRY_RUN'; action: TRetentionSettings['action'] }
  | { result: 'SOFT_DELETED' }
  | { result: 'PURGED'; objectKeysToDelete: string[] };

/**
 * Apply the team's retention rule to one envelope.
 *
 * The rule is read again here, not taken from the sweep, so a rule that was
 * changed or turned off while the sweep was running is respected. Every write
 * repeats the eligibility test in its WHERE clause, so a document that changed
 * in the meantime is left alone.
 *
 * A purge returns the object-storage keys to delete. The caller deletes them
 * after the rows are gone (see `deleteRetentionObjects`), so a crash leaves an
 * unreferenced object rather than a row pointing at a missing file.
 */
export const applyRetentionToEnvelope = async ({
  envelopeId,
  now = new Date(),
  dryRun = isRetentionDryRun(),
}: {
  envelopeId: string;
  now?: Date;
  dryRun?: boolean;
}): Promise<RetentionOutcome> => {
  const envelope = await prisma.envelope.findUnique({
    where: { id: envelopeId },
    select: { id: true, teamId: true, type: true, status: true, completedAt: true, deletedAt: true },
  });

  if (!envelope) {
    return { result: 'SKIPPED', reason: 'Envelope not found' };
  }

  const settings = await getTeamRetentionSettings(envelope.teamId);

  if (!settings || !isEnvelopeRetentionEligible({ envelope, settings, now })) {
    return { result: 'SKIPPED', reason: 'Not eligible under the current rule' };
  }

  // Solid Ten Sign (S-M3): no purge below the minimum or inside the grace period after a change.
  const purgeBlock =
    settings.action === 'PURGE' ? await getRetentionPurgeBlock({ teamId: envelope.teamId, settings, now }) : null;

  if (purgeBlock) {
    logger.info({ msg: '[RETENTION] Purge held back', envelopeId: envelope.id, teamId: envelope.teamId, purgeBlock });

    return { result: 'SKIPPED', reason: `Purge held back: ${purgeBlock}` };
  }

  if (dryRun) {
    logger.info({
      msg: `[RETENTION] Dry run: would ${settings.action === 'PURGE' ? 'purge' : 'soft-delete'} envelope`,
      envelopeId: envelope.id,
      teamId: envelope.teamId,
      completedAt: envelope.completedAt,
      days: settings.days,
    });

    return { result: 'DRY_RUN', action: settings.action };
  }

  if (settings.action === 'SOFT_DELETE') {
    return await softDeleteEnvelope({ envelopeId: envelope.id, settings, now });
  }

  return await purgeEnvelope({ envelopeId: envelope.id, settings, now });
};

const buildEligibleWhere = (envelopeId: string, settings: TRetentionSettings, now: Date) => ({
  id: envelopeId,
  status: { in: getRetentionStatuses(settings) },
  completedAt: { not: null, lte: getRetentionCutoff(settings, now) },
});

const softDeleteEnvelope = async ({
  envelopeId,
  settings,
  now,
}: {
  envelopeId: string;
  settings: TRetentionSettings;
  now: Date;
}): Promise<RetentionOutcome> => {
  return await prisma.$transaction(async (tx) => {
    if (!(await lockEnvelopeForRetention(tx, envelopeId))) {
      return { result: 'SKIPPED', reason: 'Envelope not found' } as const;
    }

    const envelope = await tx.envelope.findUniqueOrThrow({
      where: { id: envelopeId },
      select: { secondaryId: true, completedAt: true },
    });

    const { count } = await tx.envelope.updateMany({
      where: { ...buildEligibleWhere(envelopeId, settings, now), deletedAt: null },
      data: { deletedAt: now },
    });

    if (count === 0) {
      return { result: 'SKIPPED', reason: 'Changed before it could be deleted' } as const;
    }

    await tx.documentAuditLog.create({
      data: createDocumentAuditLogData({
        type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_RETENTION_APPLIED,
        envelopeId,
        requestMetadata: { userAgent: RETENTION_USER_AGENT },
        data: {
          action: 'SOFT_DELETE',
          days: settings.days,
          completedAt: envelope.completedAt?.toISOString() ?? '',
          envelopeId,
          documentId: mapSecondaryIdToDocumentId(envelope.secondaryId),
          auditLogIds: [],
          deletedObjectCount: 0,
          keptSharedObjectCount: 0,
        },
      }),
    });

    return { result: 'SOFT_DELETED' } as const;
  });
};

const purgeEnvelope = async ({
  envelopeId,
  settings,
  now,
}: {
  envelopeId: string;
  settings: TRetentionSettings;
  now: Date;
}): Promise<RetentionOutcome> => {
  const envelope = await prisma.envelope.findUnique({
    where: { id: envelopeId },
    include: {
      documentMeta: true,
      recipients: true,
      // Ids only: with database storage a stored-data row holds the whole PDF.
      envelopeItems: { select: { documentDataId: true } },
      contents: { select: { dataContentId: true } },
    },
  });

  // Another run purged it first.
  if (!envelope) {
    return { result: 'SKIPPED', reason: 'Envelope not found' };
  }

  // Captured before the rows go, so the webhook can describe what was purged.
  const webhookPayload = ZWebhookDocumentSchema.parse(mapEnvelopeToWebhookDocumentPayload(envelope));

  const documentDataIds = await findPurgeableDocumentDataIds(envelope);

  const documentDataPlan = await planPurgedObjectKeys(documentDataIds);

  const dataContentIds = [
    ...new Set([
      ...envelope.contents.flatMap((content) => (content.dataContentId ? [content.dataContentId] : [])),
      // Files signers attached. Never shared, so they always count as orphaned below.
      ...(await getEnvelopeFieldFileDataContentIds(envelope.id)),
    ]),
  ];

  const objectKeysToDelete = await prisma
    .$transaction(async (tx) => {
      if (!(await lockEnvelopeForRetention(tx, envelopeId))) {
        throw new RetentionChangedError();
      }

      // Solid Ten Sign (G2): the document's audit-log rows go with it (they hold names, email
      // addresses, IP addresses, user agents and typed values). One minimal record stays, written
      // after the erase and linked to the envelope until the delete below unlinks it
      // (DocumentAuditLog.envelope is SET NULL). Same transaction: a failed purge erases nothing.
      const { count: erasedAuditLogCount } = await tx.documentAuditLog.deleteMany({ where: { envelopeId } });

      await tx.documentAuditLog.create({
        data: createDocumentAuditLogData({
          type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_RETENTION_APPLIED,
          envelopeId,
          requestMetadata: { userAgent: RETENTION_USER_AGENT },
          data: buildPurgeRecordData({
            settings,
            envelope: {
              id: envelopeId,
              documentId: mapSecondaryIdToDocumentId(envelope.secondaryId),
              completedAt: envelope.completedAt,
              recipientCount: envelope.recipients.length,
            },
            erasedAuditLogCount,
            deletedObjectCount: documentDataPlan.keysToDelete.length,
            keptSharedObjectCount: documentDataPlan.keysKept.length,
          }),
        }),
      });

      // Comments go with the document (the text is not kept in the audit log).
      await deleteEnvelopeComments(tx, envelopeId);

      await purgeEnvelopeCopies(tx, { envelopeId, teamId: envelope.teamId });

      const { count } = await tx.envelope.deleteMany({
        where: buildEligibleWhere(envelopeId, settings, now),
      });

      if (count === 0) {
        throw new RetentionChangedError();
      }

      // Hard deleting an envelope leaves these behind; a purge must not.
      await tx.documentMeta.deleteMany({ where: { id: envelope.documentMetaId } });

      await tx.documentData.deleteMany({ where: { id: { in: documentDataIds } } });

      await tx.detachedDocumentData.deleteMany({ where: { envelopeId } });

      // Images are shared with the template a document came from, so only images
      // nothing else points at any more are removed.
      const orphanedIds = (
        await tx.dataContent.findMany({
          where: { id: { in: dataContentIds }, envelopeContents: { none: {} } },
          select: { id: true },
        })
      ).map((content) => content.id);

      // Only object-storage rows hold a short key worth reading; inline images go with their rows.
      const orphanedObjectKeys = (
        await tx.dataContent.findMany({
          where: { id: { in: orphanedIds }, type: DocumentDataType.S3_PATH },
          select: { data: true },
        })
      ).map((content) => content.data);

      const sharedKeys = new Set(
        (
          await tx.dataContent.findMany({
            where: { id: { notIn: orphanedIds }, type: DocumentDataType.S3_PATH, data: { in: orphanedObjectKeys } },
            select: { data: true },
          })
        ).map((content) => content.data),
      );

      await tx.dataContent.deleteMany({ where: { id: { in: orphanedIds } } });

      const dataContentKeys = orphanedObjectKeys.filter((key) => !sharedKeys.has(key));

      return [...documentDataPlan.keysToDelete, ...dataContentKeys];
    })
    .catch((err) => {
      if (err instanceof RetentionChangedError) {
        return null;
      }

      throw err;
    });

  if (objectKeysToDelete === null) {
    return { result: 'SKIPPED', reason: 'Changed before it could be purged' };
  }

  await triggerWebhook({
    event: WebhookTriggerEvents.DOCUMENT_PURGED,
    data: webhookPayload,
    userId: envelope.userId,
    teamId: envelope.teamId,
  });

  return { result: 'PURGED', objectKeysToDelete };
};

class RetentionChangedError extends Error {}

/**
 * Lock the envelope row for the rest of the transaction. Two runs acting on the
 * same envelope (a re-run job, a second instance) then take turns instead of
 * deadlocking on the audit entry's foreign key; the second finds it gone or
 * already done. Returns false when the envelope no longer exists.
 */
const lockEnvelopeForRetention = async (tx: Prisma.TransactionClient, envelopeId: string) => {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Envelope" WHERE "id" = ${envelopeId} FOR UPDATE`;

  return rows.length > 0;
};

/**
 * The stored-data rows a purge deletes, by id: every row the envelope's items point
 * at, and every earlier copy an item stopped pointing at (recorded by the
 * DetachedDocumentData trigger), unless some live item still points at that row.
 * No PDF content is read: with database storage it is the whole file.
 */
const findPurgeableDocumentDataIds = async (envelope: { id: string; envelopeItems: { documentDataId: string }[] }) => {
  const detached = await prisma.detachedDocumentData.findMany({
    where: { envelopeId: envelope.id },
    select: { documentDataId: true },
  });

  const candidateIds = [
    ...new Set([
      ...envelope.envelopeItems.map((item) => item.documentDataId),
      ...detached.map((row) => row.documentDataId),
    ]),
  ];

  const stillLinkedElsewhere = await prisma.envelopeItem.findMany({
    where: { documentDataId: { in: candidateIds }, envelopeId: { not: envelope.id } },
    select: { documentDataId: true },
  });

  const keep = new Set(stillLinkedElsewhere.map((item) => item.documentDataId));

  return candidateIds.filter((id) => !keep.has(id));
};

/**
 * Object-storage keys to delete with the rows. Only S3_PATH rows are read (their
 * values are short keys); a key still held by any row that stays, such as the
 * template a document was made from, is kept. Database-stored files need nothing
 * here: they go with their rows.
 */
const planPurgedObjectKeys = async (documentDataIds: string[]) => {
  const ownObjectRows = await prisma.documentData.findMany({
    where: { id: { in: documentDataIds }, type: DocumentDataType.S3_PATH },
    select: { type: true, data: true, initialData: true },
  });

  const ownKeys = [...new Set(ownObjectRows.flatMap((row) => [row.data, row.initialData]))];

  const rowsKeepingKeys =
    ownKeys.length === 0
      ? []
      : await prisma.documentData.findMany({
          where: {
            id: { notIn: documentDataIds },
            type: DocumentDataType.S3_PATH,
            OR: [{ data: { in: ownKeys } }, { initialData: { in: ownKeys } }],
          },
          select: { data: true, initialData: true },
        });

  return planStoredObjectDeletion({
    ownRows: ownObjectRows,
    valuesUsedElsewhere: new Set(rowsKeepingKeys.flatMap((row) => [row.data, row.initialData])),
  });
};

/**
 * Remove purged files from object storage. Each key is tried on its own so one
 * failure does not keep the rest; failed keys are returned for the caller to log.
 */
export const deleteRetentionObjects = async (keys: string[]) => {
  const failedKeys: string[] = [];

  for (const key of keys) {
    try {
      await deleteFile({ type: DocumentDataType.S3_PATH, data: key });
    } catch (err) {
      logger.error({ msg: '[RETENTION] Failed to delete stored object', key, err });
      failedKeys.push(key);
    }
  }

  return failedKeys;
};
