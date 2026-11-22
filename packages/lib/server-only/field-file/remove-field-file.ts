import { prisma } from '@documenso/prisma';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../types/document-audit-logs';
import type { RequestMetadata } from '../../universal/extract-request-metadata';
import { createDocumentAuditLogData } from '../../utils/document-audit-logs';
import { applyFieldLogic } from '../field-logic/apply-field-logic';
import { getSignerFileFieldContext, lockFileEnvelope, syncFileFieldValue } from './field-file-context';
import { deleteStoredFieldFiles } from './remove-field-files-in-transaction';

export type RemoveFieldFileOptions = {
  token: string;
  fieldId: number;
  fileId: string;
  requestMetadata: RequestMetadata;
};

/**
 * Remove one of the signer's own files from a field, before they complete.
 */
export const removeFieldFile = async ({ token, fieldId, fileId, requestMetadata }: RemoveFieldFileOptions) => {
  const { recipient, field, envelope } = await getSignerFileFieldContext({ token, fieldId });

  const { result, stored } = await prisma.$transaction(async (tx) => {
    await lockFileEnvelope(tx, { envelopeId: envelope.id, recipientId: recipient.id });

    const upload = await tx.fieldFileUpload.findFirst({
      where: { id: fileId, fieldId: field.id, recipientId: recipient.id },
    });

    if (!upload) {
      throw new AppError(AppErrorCode.NOT_FOUND, {
        message: 'The file was not found.',
      });
    }

    // Deleting the data content removes the upload row with it.
    const storedContent = await tx.dataContent.delete({
      where: { id: upload.dataContentId },
      select: { type: true, data: true },
    });

    await tx.documentAuditLog.create({
      data: createDocumentAuditLogData({
        type: DOCUMENT_AUDIT_LOG_TYPE.FIELD_FILE_REMOVED,
        envelopeId: envelope.id,
        user: { name: recipient.name, email: recipient.email },
        requestMetadata,
        data: {
          fieldId: field.secondaryId,
          recipientId: recipient.id,
          recipientEmail: recipient.email,
          recipientName: recipient.name,
          fileId: upload.id,
          fileName: upload.fileName,
          size: upload.size,
          sha256: upload.sha256,
          reason: 'SIGNER',
        },
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

    return { result: { signedField, affectedFields: changedFields }, stored: [storedContent, ...removedFileObjects] };
  });

  await deleteStoredFieldFiles(stored);

  return result;
};
