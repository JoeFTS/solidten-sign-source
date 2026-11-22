import { type Field, FieldType } from '@prisma/client';

import { fieldUsesLogic, readFieldLogicMeta, resolveFieldLogic } from './field-conditions';
import { parseFieldNumberValue } from './field-number-value';

export type DirectTemplateSubmittedValue = {
  fieldId: number;
  value?: string;
  isBase64?: boolean;
};

export type DirectTemplateFieldLogicResult<T extends DirectTemplateSubmittedValue> =
  | {
      success: true;
      /**
       * The values to store. Hidden and calculated fields are left out: a hidden field stays
       * empty and the server writes calculated fields itself after the document exists.
       */
      signedFieldValues: T[];
      /**
       * Fields that must not be required even when their meta says so.
       */
      notRequiredFieldIds: Set<number>;
    }
  | {
      success: false;
      fieldId: number;
      reason:
        | 'HIDDEN_FIELD_HAS_VALUE'
        | 'CALCULATED_VALUE_CHANGED'
        | 'READ_ONLY_VALUE_CHANGED'
        | 'CONDITIONAL_FIELD_EMPTY';
    };

const isReadOnly = (fieldMeta: unknown) =>
  typeof fieldMeta === 'object' &&
  fieldMeta !== null &&
  !Array.isArray(fieldMeta) &&
  (fieldMeta as Record<string, unknown>).readOnly === true;

const isRequiredMeta = (fieldMeta: unknown) =>
  typeof fieldMeta === 'object' &&
  fieldMeta !== null &&
  !Array.isArray(fieldMeta) &&
  (fieldMeta as Record<string, unknown>).required === true;

/**
 * Apply the field rules to a direct template submission, which arrives in one request with
 * every value computed in the browser.
 *
 * Visibility and calculated values are worked out again here from the submitted values of
 * the signer-editable fields and the sender's values of read-only fields, with the same
 * pure code the signing page uses. A submission is refused when it carries a value for a
 * field the rules hide, a calculated value that differs from the server's, a changed
 * read-only value, or leaves a shown conditional required field empty. A browser that runs
 * the signing page never sends any of these, so a refusal means the request was tampered with.
 *
 * `fields` must be every field of the direct recipient on the template. `readOnlyValues`
 * holds the server's value for each read-only field.
 */
export const applyDirectTemplateFieldLogic = <T extends DirectTemplateSubmittedValue>({
  fields,
  signedFieldValues,
  readOnlyValues,
}: {
  fields: (Pick<Field, 'id' | 'type' | 'recipientId' | 'envelopeItemId' | 'customText'> & { fieldMeta: unknown })[];
  signedFieldValues: T[];
  readOnlyValues: Map<number, string>;
}): DirectTemplateFieldLogicResult<T> => {
  if (!fields.some((field) => fieldUsesLogic(field.fieldMeta))) {
    return { success: true, signedFieldValues, notRequiredFieldIds: new Set() };
  }

  const submitted = new Map(signedFieldValues.map((value) => [value.fieldId, value]));

  const simulatedFields = fields.map((field) => {
    const readOnlyValue = readOnlyValues.get(field.id);
    const customText = readOnlyValue ?? submitted.get(field.id)?.value ?? '';

    return {
      ...field,
      customText,
      inserted: customText !== '',
    };
  });

  const states = resolveFieldLogic(simulatedFields);

  const notRequiredFieldIds = new Set<number>();
  const keptValues: T[] = [];

  for (const field of fields) {
    const state = states.get(field.id);
    const value = submitted.get(field.id);
    const hasValue = Boolean(value?.value);
    const { condition } = readFieldLogicMeta(field.fieldMeta);

    if (state?.isHidden) {
      notRequiredFieldIds.add(field.id);

      if (hasValue && !readOnlyValues.has(field.id)) {
        return { success: false, fieldId: field.id, reason: 'HIDDEN_FIELD_HAS_VALUE' };
      }

      continue;
    }

    if (state && state.calculatedValue !== null) {
      notRequiredFieldIds.add(field.id);

      // Compared as numbers: the browser may write the same value differently (for
      // example with or without grouping), and the server's own value must always pass.
      if (hasValue && !isSameCalculatedValue(value?.value ?? '', state.calculatedValue, field.fieldMeta)) {
        return { success: false, fieldId: field.id, reason: 'CALCULATED_VALUE_CHANGED' };
      }

      continue;
    }

    const readOnlyValue = readOnlyValues.get(field.id);

    if (readOnlyValue !== undefined && field.type !== FieldType.DATE) {
      if (hasValue && value?.value !== readOnlyValue) {
        return { success: false, fieldId: field.id, reason: 'READ_ONLY_VALUE_CHANGED' };
      }

      if (value) {
        keptValues.push({ ...value, value: readOnlyValue });
      }

      continue;
    }

    if (condition && isRequiredMeta(field.fieldMeta) && !hasValue && field.type !== FieldType.DATE) {
      return { success: false, fieldId: field.id, reason: 'CONDITIONAL_FIELD_EMPTY' };
    }

    if (value) {
      keptValues.push(value);
    }
  }

  return { success: true, signedFieldValues: keptValues, notRequiredFieldIds };
};

/**
 * The fields of a template whose stored value the signer can never change.
 */
export const isDirectTemplateReadOnlyField = (field: { fieldMeta: unknown }) => isReadOnly(field.fieldMeta);

const isSameCalculatedValue = (submitted: string, calculated: string, fieldMeta: unknown) => {
  if (submitted === calculated) {
    return true;
  }

  const meta = typeof fieldMeta === 'object' && fieldMeta !== null ? (fieldMeta as Record<string, unknown>) : {};
  const numberFormat = typeof meta.numberFormat === 'string' ? meta.numberFormat : null;

  const left = parseFieldNumberValue(submitted, numberFormat) ?? parseFieldNumberValue(submitted);
  const right = parseFieldNumberValue(calculated, numberFormat);

  return left !== null && right !== null && left === right;
};
