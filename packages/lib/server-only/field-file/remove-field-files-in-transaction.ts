import type { DocumentDataType, Prisma } from '@prisma/client';

import { DOCUMENT_AUDIT_LOG_TYPE } from '../../types/document-audit-logs';
import type { ApiRequestMetadata, RequestMetadata } from '../../universal/extract-request-metadata';
import { deleteFile } from '../../universal/upload/delete-file';
import { createDocumentAuditLogData } from '../../utils/document-audit-logs';
import { logger } from '../../utils/logger';

export type StoredFieldFile = { type: DocumentDataType; data: string };

/**
 * Delete stored bytes after their row is gone. Database storage needs nothing: the bytes
 * went with the row. A failure is logged, never thrown, so it cannot undo the change.
 */
export const deleteStoredFieldFile = async (stored: StoredFieldFile) => {
  if (stored.type !== 'S3_PATH') {
    return;
  }

  try {
    await deleteFile(stored);
  } catch (err) {
    logger.error({ msg: '[FIELD_FILE] Failed to delete a stored file', key: stored.data, err });
  }
};

export type RemoveFieldFilesInTransactionOptions = {
  tx: Prisma.TransactionClient;
  envelopeId: string;
  fieldIds: number[];
  reason: 'CONDITION' | 'REASSIGNED';
  user?: { id?: number | null; name?: string | null; email?: string | null } | null;
  requestMetadata?: RequestMetadata;
  metadata?: ApiRequestMetadata;
};

/**
 * Remove every file of the given fields inside the caller's transaction, for example when
 * a condition hides a field or a reassignment clears it. Returns what was stored so the
 * caller can delete object-storage files once the transaction commits; an object left
 * behind by a crash is unreferenced, never a row pointing at a missing file.
 */
export const removeFieldFilesInTransaction = async ({
  tx,
  envelopeId,
  fieldIds,
  reason,
  user,
  requestMetadata,
  metadata,
}: RemoveFieldFilesInTransactionOptions): Promise<StoredFieldFile[]> => {
  if (fieldIds.length === 0) {
    return [];
  }

  const uploads = await tx.fieldFileUpload.findMany({
    where: { envelopeId, fieldId: { in: fieldIds } },
    include: { field: { select: { secondaryId: true } }, dataContent: { select: { type: true, data: true } } },
  });

  if (uploads.length === 0) {
    return [];
  }

  await tx.dataContent.deleteMany({
    where: { id: { in: uploads.map((upload) => upload.dataContentId) } },
  });

  await tx.documentAuditLog.createMany({
    data: uploads.map((upload) =>
      createDocumentAuditLogData({
        type: DOCUMENT_AUDIT_LOG_TYPE.FIELD_FILE_REMOVED,
        envelopeId,
        user: user ? { id: user.id ?? null, name: user.name ?? null, email: user.email ?? null } : undefined,
        requestMetadata,
        metadata,
        data: {
          fieldId: upload.field.secondaryId,
          recipientId: upload.recipientId,
          recipientEmail: upload.uploaderEmail,
          recipientName: upload.uploaderName,
          fileId: upload.id,
          fileName: upload.fileName,
          size: upload.size,
          sha256: upload.sha256,
          reason,
        },
      }),
    ),
  });

  return uploads.map((upload) => upload.dataContent);
};

/**
 * Delete object-storage files returned by `removeFieldFilesInTransaction`.
 */
export const deleteStoredFieldFiles = async (stored: StoredFieldFile[]) => {
  for (const item of stored) {
    await deleteStoredFieldFile(item);
  }
};

/**
 * Finish a transaction that may have removed field files: delete their stored objects
 * once it has committed, and drop the list from the result. Chain it with `.then`.
 */
export const deleteRemovedFieldFiles = async <T extends { removedFileObjects: StoredFieldFile[] }>(
  transactionResult: T,
): Promise<Omit<T, 'removedFileObjects'>> => {
  const { removedFileObjects, ...result } = transactionResult;

  await deleteStoredFieldFiles(removedFileObjects);

  return result;
};
