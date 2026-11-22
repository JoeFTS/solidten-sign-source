import { createHash } from 'node:crypto';

import { prisma } from '@documenso/prisma';

import { FIELD_FILE_KIND_LABELS, getFieldFileEnvelopeMaxBytes, getFieldFileMaxBytes } from '../../constants/field-file';
import { AppError, AppErrorCode } from '../../errors/app-error';
import { DataContentType, ZDataContentMetaSchema } from '../../types/data-content-meta';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../types/document-audit-logs';
import type { RequestMetadata } from '../../universal/extract-request-metadata';
import { prefixedId } from '../../universal/id';
import { putFileServerSide } from '../../universal/upload/put-file.server';
import { createDocumentAuditLogData } from '../../utils/document-audit-logs';
import {
  checkFieldFileLimits,
  detectFieldFileKind,
  resolveAllowedFileKinds,
  resolveFieldMaxFiles,
  sanitizeFieldFileName,
} from '../../utils/field-file';
import { logger } from '../../utils/logger';
import { applyFieldLogic } from '../field-logic/apply-field-logic';
import { getSignerFileFieldContext, lockFileEnvelope, syncFileFieldValue } from './field-file-context';
import { deleteStoredFieldFile, deleteStoredFieldFiles } from './remove-field-files-in-transaction';

export type UploadFieldFileOptions = {
  token: string;
  fieldId: number;
  file: {
    name: string;
    size: number;
    arrayBuffer: () => Promise<ArrayBuffer>;
  };
  /**
   * A file of the same field to swap for the new one.
   */
  replaceFileId?: string | null;
  requestMetadata: RequestMetadata;
};

/**
 * Store a file a signer attached to an "Attach a file" field.
 *
 * The bytes are checked (real kind, the field's allowlist, size, count and the envelope
 * cap) before anything is stored. They are stored as is under a random name and hashed,
 * so the hash in the certificate is the hash of what the signer sent.
 */
/**
 * Solid Ten: the file is stored before this transaction; the transaction only takes the lock and
 * writes rows, but under load it ran past the 10 s client default (LD2-A).
 */
const FIELD_FILE_TRANSACTION_OPTIONS = { timeout: 30_000, maxWait: 15_000 };

export const uploadFieldFile = async ({
  token,
  fieldId,
  file,
  replaceFileId,
  requestMetadata,
}: UploadFieldFileOptions) => {
  const { recipient, field, envelope, fileMeta } = await getSignerFileFieldContext({ token, fieldId });

  const maxFileBytes = getFieldFileMaxBytes();

  // Checked before the bytes are read, so an oversize file is refused cheaply.
  if (file.size > maxFileBytes) {
    const check = checkFieldFileLimits({
      fileSize: file.size,
      maxFileBytes,
      fieldFileCount: 0,
      maxFiles: 1,
      envelopeBytes: 0,
      maxEnvelopeBytes: Number.MAX_SAFE_INTEGER,
    });

    throw new AppError(AppErrorCode.INVALID_BODY, {
      message: check.ok ? 'The file is too large.' : check.message,
    });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  const detection = detectFieldFileKind(bytes, file.name);
  const allowedKinds = resolveAllowedFileKinds(fileMeta.allowedFileTypes);

  if (!detection.ok || !allowedKinds.includes(detection.kind)) {
    if (!detection.ok) {
      logger.info({
        msg: '[FIELD_FILE] Refused a file',
        envelopeId: envelope.id,
        fieldId: field.id,
        reason: detection.reason,
        detail: detection.detail,
      });
    }

    throw new AppError(AppErrorCode.INVALID_BODY, {
      message:
        detection.ok || detection.reason !== 'EMPTY'
          ? `This type of file is not allowed. Allowed: ${allowedKinds.map((kind) => FIELD_FILE_KIND_LABELS[kind]).join(', ')}.`
          : 'The file is empty.',
    });
  }

  const fileName = sanitizeFieldFileName(file.name, detection.kind);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const fileId = prefixedId('ffile', 16);

  const parsedMeta = ZDataContentMetaSchema.parse({
    type: DataContentType.FILE,
    mimeType: detection.mimeType,
    fileName,
    fileSize: bytes.byteLength,
    sha256,
  });

  const stored = await putFileServerSide({
    // A random stored name: the signer's name never reaches the storage key.
    name: `${fileId}.bin`,
    type: 'application/octet-stream',
    arrayBuffer: async () => Promise.resolve(bytes),
  });

  try {
    const transaction = await prisma.$transaction(async (tx) => {
      await lockFileEnvelope(tx, { envelopeId: envelope.id, recipientId: recipient.id });

      const existingUploads = await tx.fieldFileUpload.findMany({
        where: { envelopeId: envelope.id },
        select: { id: true, fieldId: true, size: true, fileName: true, sha256: true, dataContentId: true },
      });

      const replaced = replaceFileId
        ? existingUploads.find((upload) => upload.id === replaceFileId && upload.fieldId === field.id)
        : undefined;

      if (replaceFileId && !replaced) {
        throw new AppError(AppErrorCode.NOT_FOUND, {
          message: 'The file to replace was not found.',
        });
      }

      const remaining = existingUploads.filter((upload) => upload.id !== replaced?.id);

      const limits = checkFieldFileLimits({
        fileSize: bytes.byteLength,
        maxFileBytes,
        fieldFileCount: remaining.filter((upload) => upload.fieldId === field.id).length,
        maxFiles: resolveFieldMaxFiles(fileMeta.maxFiles),
        envelopeBytes: remaining.reduce((sum, upload) => sum + upload.size, 0),
        maxEnvelopeBytes: getFieldFileEnvelopeMaxBytes(),
      });

      if (!limits.ok) {
        throw new AppError(AppErrorCode.INVALID_BODY, { message: limits.message });
      }

      // Deleting the data content removes the replaced upload row with it.
      const replacedContent = replaced
        ? await tx.dataContent.delete({
            where: { id: replaced.dataContentId },
            select: { type: true, data: true },
          })
        : null;

      const dataContent = await tx.dataContent.create({
        data: {
          id: prefixedId('data', 16),
          type: stored.type,
          data: stored.data,
          metadata: parsedMeta,
        },
      });

      const upload = await tx.fieldFileUpload.create({
        data: {
          id: fileId,
          envelopeId: envelope.id,
          fieldId: field.id,
          recipientId: recipient.id,
          dataContentId: dataContent.id,
          fileName,
          mimeType: detection.mimeType,
          size: bytes.byteLength,
          sha256,
          uploaderName: recipient.name,
          uploaderEmail: recipient.email,
        },
      });

      const baseData = {
        fieldId: field.secondaryId,
        recipientId: recipient.id,
        recipientEmail: recipient.email,
        recipientName: recipient.name,
        fileId: upload.id,
        fileName: upload.fileName,
        size: upload.size,
        sha256: upload.sha256,
      };

      await tx.documentAuditLog.create({
        data: replaced
          ? createDocumentAuditLogData({
              type: DOCUMENT_AUDIT_LOG_TYPE.FIELD_FILE_REPLACED,
              envelopeId: envelope.id,
              user: { name: recipient.name, email: recipient.email },
              requestMetadata,
              data: {
                ...baseData,
                previousFileId: replaced.id,
                previousFileName: replaced.fileName,
                previousSize: replaced.size,
                previousSha256: replaced.sha256,
              },
            })
          : createDocumentAuditLogData({
              type: DOCUMENT_AUDIT_LOG_TYPE.FIELD_FILE_UPLOADED,
              envelopeId: envelope.id,
              user: { name: recipient.name, email: recipient.email },
              requestMetadata,
              data: baseData,
            }),
      });

      const signedField = await syncFileFieldValue(tx, field.id);

      const { changedFields, removedFileObjects } = await applyFieldLogic({
        tx,
        envelopeId: envelope.id,
        recipientId: recipient.id,
        user: recipient,
        requestMetadata,
      });

      return {
        result: { upload, signedField, affectedFields: changedFields },
        removedFiles: [...(replacedContent ? [replacedContent] : []), ...removedFileObjects],
      };
    }, FIELD_FILE_TRANSACTION_OPTIONS);

    await deleteStoredFieldFiles(transaction.removedFiles);

    return transaction.result;
  } catch (err) {
    // The row was never written, so the stored object would be unreferenced.
    await deleteStoredFieldFile(stored);

    throw err;
  }
};
