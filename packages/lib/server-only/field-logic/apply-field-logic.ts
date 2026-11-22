import { type Field, FieldType, type Prisma } from '@prisma/client';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../types/document-audit-logs';
import type { RequestMetadata } from '../../universal/extract-request-metadata';
import { createDocumentAuditLogData } from '../../utils/document-audit-logs';
import { fieldUsesLogic, readFieldLogicMeta, resolveFieldLogic } from '../../utils/field-conditions';
import { removeFieldFilesInTransaction, type StoredFieldFile } from '../field-file/remove-field-files-in-transaction';

export type ApplyFieldLogicOptions = {
  tx: Prisma.TransactionClient;
  envelopeId: string;
  recipientId: number;
  /**
   * The person whose action caused the change, recorded on the audit entries.
   */
  user?: { name?: string | null; email?: string | null } | null;
  requestMetadata?: RequestMetadata;
};

const isFieldReadOnly = (field: Pick<Field, 'fieldMeta'>) => {
  const meta = field.fieldMeta;

  return typeof meta === 'object' && meta !== null && !Array.isArray(meta) && meta.readOnly === true;
};

/**
 * Bring one recipient's stored field values in line with the field rules.
 *
 * A calculated field gets the value the server computes from its sources. A hidden field
 * must not keep a value the signer typed while it was shown, so it is cleared. Each
 * change has an audit entry. Read-only fields keep their sender value: they are never
 * typed by the signer, and the PDF export skips them while hidden.
 *
 * Returns the fields whose stored values changed, and (Solid Ten) the stored files of
 * hidden "Attach a file" fields, for the caller to delete once the transaction commits.
 */
export const applyFieldLogic = async ({
  tx,
  envelopeId,
  recipientId,
  user,
  requestMetadata,
}: ApplyFieldLogicOptions) => {
  const fields = await tx.field.findMany({
    where: {
      envelopeId,
      recipientId,
    },
  });

  if (!fields.some((field) => fieldUsesLogic(field.fieldMeta))) {
    return { changedFields: [], removedFileObjects: [] };
  }

  const states = resolveFieldLogic(fields);

  const changedFields: Field[] = [];
  const removedFileObjects: StoredFieldFile[] = [];

  for (const field of fields) {
    const state = states.get(field.id);

    if (state && state.calculatedValue !== null) {
      const value = state.calculatedValue;
      const isInserted = value !== '';

      if (field.customText === value && field.inserted === isInserted) {
        continue;
      }

      const calculatedField = await tx.field.update({
        where: {
          id: field.id,
        },
        data: {
          customText: value,
          inserted: isInserted,
        },
      });

      await tx.documentAuditLog.create({
        data: createDocumentAuditLogData({
          type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_FIELD_CALCULATED,
          envelopeId,
          user: user ? { name: user.name ?? null, email: user.email ?? null } : undefined,
          requestMetadata,
          data: {
            fieldId: field.secondaryId,
            recipientId,
            formula: readFieldLogicMeta(field.fieldMeta).formula ?? '',
            value,
          },
        }),
      });

      changedFields.push(calculatedField);

      continue;
    }

    if (!state?.isHidden || !field.inserted || isFieldReadOnly(field)) {
      continue;
    }

    const clearedField = await tx.field.update({
      where: {
        id: field.id,
      },
      data: {
        customText: '',
        inserted: false,
      },
    });

    await tx.signature.deleteMany({
      where: {
        fieldId: field.id,
      },
    });

    // Solid Ten: a hidden "Attach a file" field loses its files too.
    if (field.type === FieldType.FILE) {
      removedFileObjects.push(
        ...(await removeFieldFilesInTransaction({
          tx,
          envelopeId,
          fieldIds: [field.id],
          reason: 'CONDITION',
          user,
          requestMetadata,
        })),
      );
    }

    await tx.documentAuditLog.create({
      data: createDocumentAuditLogData({
        type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_FIELD_CONDITION_CLEARED,
        envelopeId,
        user: user ? { name: user.name ?? null, email: user.email ?? null } : undefined,
        requestMetadata,
        data: {
          field: field.type,
          fieldId: field.secondaryId,
          recipientId,
          conditionFieldKey: readFieldLogicMeta(field.fieldMeta).condition?.fieldKey ?? '',
        },
      }),
    });

    changedFields.push(clearedField);
  }

  return { changedFields, removedFileObjects };
};

/**
 * Refuse a signer action on a field that the rules do not let the signer change.
 */
export const assertFieldSignableByLogic = async ({
  tx,
  field,
}: {
  tx: Prisma.TransactionClient;
  field: Pick<Field, 'id' | 'envelopeId' | 'envelopeItemId' | 'recipientId' | 'fieldMeta'>;
}) => {
  const { condition, formula } = readFieldLogicMeta(field.fieldMeta);

  if (formula) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: `Field ${field.id} is calculated by the server and cannot be signed`,
    });
  }

  if (!condition) {
    return;
  }

  const siblingFields = await tx.field.findMany({
    where: {
      envelopeId: field.envelopeId,
      envelopeItemId: field.envelopeItemId,
      recipientId: field.recipientId,
    },
  });

  if (resolveFieldLogic(siblingFields).get(field.id)?.isHidden) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: `Field ${field.id} is hidden because its condition is not met`,
    });
  }
};

/**
 * Apply the field rules for every recipient of an envelope, for example right after send
 * so calculated fields whose sources are all prefilled already show their value.
 */
export const applyFieldLogicForEnvelope = async ({
  tx,
  envelopeId,
}: Pick<ApplyFieldLogicOptions, 'tx' | 'envelopeId'>) => {
  const recipients = await tx.recipient.findMany({
    where: {
      envelopeId,
    },
    select: {
      id: true,
    },
  });

  for (const recipient of recipients) {
    await applyFieldLogic({ tx, envelopeId, recipientId: recipient.id });
  }
};
