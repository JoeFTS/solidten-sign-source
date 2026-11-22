import type { TSignFieldWithTokenMutationSchema } from '@documenso/trpc/server/field-router/schema';
import { type Field, FieldType, type Prisma, type Recipient } from '@prisma/client';

import { validateNumberField } from '../../advanced-fields-validation/validate-number';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { ZNumberFieldMeta } from '../../types/field-meta';
import { applyDirectTemplateFieldLogic, isDirectTemplateReadOnlyField } from '../../utils/direct-template-field-logic';
import { isCalculatedField } from '../../utils/field-conditions';
import { extractFieldAutoInsertValues } from '../document/send-document';

export type DirectTemplateCreatedContext = {
  tx: Prisma.TransactionClient;
  envelopeId: string;
  recipientId: number;
  recipientName: string;
  recipientEmail: string;
};

export type DirectTemplateHooks = {
  /**
   * The public form did not verify the typed address. No mail goes to that address (its recipient
   * row gets `unverifiedEmailAt`); the other recipients and the owner notices are unchanged.
   */
  disableRecipientEmails?: boolean;
  /**
   * Runs inside the transaction that creates the document, after its audit entries.
   */
  onCreated?: (context: DirectTemplateCreatedContext) => Promise<void>;
};

/**
 * Enforce the field rules on a direct template submission. Throws when the submission was
 * tampered with; see `applyDirectTemplateFieldLogic`.
 */
export const applyDirectTemplateSubmissionRules = ({
  directTemplateRecipient,
  signedFieldValues,
}: {
  directTemplateRecipient: Recipient & { fields: Field[] };
  signedFieldValues: TSignFieldWithTokenMutationSchema[];
}) => {
  // Solid Ten: number values must match their field's format exactly (see
  // `parseFieldNumberValue`); the browser runs the same check before it submits.
  for (const signedFieldValue of signedFieldValues) {
    const field = directTemplateRecipient.fields.find((candidate) => candidate.id === signedFieldValue.fieldId);

    // A calculated value is the server's own; `applyDirectTemplateFieldLogic` compares it
    // with the server's result numerically and never stores the submitted text.
    if (
      field?.type !== FieldType.NUMBER ||
      !signedFieldValue.value ||
      isDirectTemplateReadOnlyField(field) ||
      isCalculatedField(field)
    ) {
      continue;
    }

    const parsedMeta = ZNumberFieldMeta.safeParse(field.fieldMeta);
    const errors = validateNumberField(signedFieldValue.value, parsedMeta.success ? parsedMeta.data : undefined, true);

    if (errors.length > 0) {
      const label =
        typeof field.fieldMeta === 'object' && field.fieldMeta && 'label' in field.fieldMeta
          ? field.fieldMeta.label
          : null;

      throw new AppError(AppErrorCode.INVALID_BODY, {
        message: `${label ? `"${label}"` : `Field ${field.id}`}: ${errors[0]}`,
      });
    }
  }

  const readOnlyValues = new Map<number, string>();

  for (const field of directTemplateRecipient.fields) {
    if (isDirectTemplateReadOnlyField(field)) {
      readOnlyValues.set(
        field.id,
        extractFieldAutoInsertValues(field, directTemplateRecipient)?.customText ?? field.customText,
      );
    }
  }

  const result = applyDirectTemplateFieldLogic({
    fields: directTemplateRecipient.fields,
    signedFieldValues,
    readOnlyValues,
  });

  if (!result.success) {
    throw new AppError(AppErrorCode.INVALID_BODY, {
      message: `Invalid, missing or changed fields (${result.reason} on field ${result.fieldId})`,
    });
  }

  return result;
};
