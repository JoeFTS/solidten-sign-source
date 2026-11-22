import { FieldType } from '@prisma/client';

import { ZFieldConditionSchema, ZFieldKeySchema } from '../types/field-logic';
import {
  type FieldLogicInput,
  findFieldLogicCycleIds,
  getFieldLogicDependencies,
  getFieldLogicGroupKey,
  readFieldLogicMeta,
} from './field-conditions';
import { parseFormula } from './field-formula';

export type FieldLogicDefinition = Pick<FieldLogicInput, 'type' | 'recipientId' | 'envelopeItemId'> & {
  /**
   * Any id that is unique in the list. New fields that have no database id yet can use
   * a negative number.
   */
  id: number;
  page?: number;
  fieldMeta?: unknown;
};

export type FieldLogicError = {
  fieldId: number;
  message: string;
};

export type ValidateFieldLogicOptions = {
  /**
   * Strict mode also rejects references to keys that do not exist. Use it when the
   * envelope is sent; while editing a sender may write the rule before placing the source.
   */
  strict?: boolean;
};

const OPTION_FIELD_TYPES: FieldType[] = [FieldType.CHECKBOX, FieldType.RADIO];
const NO_VALUE_FIELD_TYPES: FieldType[] = [FieldType.SIGNATURE, FieldType.FREE_SIGNATURE];

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const getOptionValues = (fieldMeta: unknown): string[] => {
  const values = asRecord(fieldMeta)?.values;

  if (!Array.isArray(values)) {
    return [];
  }

  return values.map((option) => asRecord(option)?.value).filter((value): value is string => typeof value === 'string');
};

export const describeFieldForLogic = (field: FieldLogicDefinition) => {
  const { fieldKey } = readFieldLogicMeta(field.fieldMeta);

  if (fieldKey) {
    return `"${fieldKey}"`;
  }

  const label = asRecord(field.fieldMeta)?.label;

  if (typeof label === 'string' && label.trim()) {
    return `"${label.trim()}"`;
  }

  return field.page
    ? `the ${field.type.toLowerCase()} field on page ${field.page}`
    : `the ${field.type.toLowerCase()} field`;
};

/**
 * Check the conditions of a full set of envelope fields. Pure: the editor calls it for
 * live feedback and the server calls it before every save and at send.
 */
export const validateFieldLogic = (
  fields: FieldLogicDefinition[],
  { strict = false }: ValidateFieldLogicOptions = {},
): FieldLogicError[] => {
  const errors: FieldLogicError[] = [];

  const keyToFields = new Map<string, FieldLogicDefinition[]>();

  for (const field of fields) {
    const meta = asRecord(field.fieldMeta);

    if (meta?.fieldKey !== undefined && !ZFieldKeySchema.safeParse(meta.fieldKey).success) {
      errors.push({
        fieldId: field.id,
        message: `The field key of ${describeFieldForLogic(field)} must start with a letter and use only letters, digits and underscores.`,
      });
    }

    if (meta?.condition !== undefined && !ZFieldConditionSchema.safeParse(meta.condition).success) {
      errors.push({ fieldId: field.id, message: `The condition of ${describeFieldForLogic(field)} is not valid.` });
    }

    const { fieldKey } = readFieldLogicMeta(field.fieldMeta);

    if (fieldKey) {
      keyToFields.set(fieldKey, [...(keyToFields.get(fieldKey) ?? []), field]);
    }
  }

  for (const [fieldKey, sameKeyFields] of keyToFields) {
    if (sameKeyFields.length > 1) {
      for (const field of sameKeyFields) {
        errors.push({ fieldId: field.id, message: `The field key "${fieldKey}" is used by more than one field.` });
      }
    }
  }

  for (const field of fields) {
    const { condition } = readFieldLogicMeta(field.fieldMeta);

    if (!condition) {
      continue;
    }

    const name = describeFieldForLogic(field);

    if (field.type === FieldType.FREE_SIGNATURE) {
      errors.push({ fieldId: field.id, message: `${name} cannot have a condition.` });
      continue;
    }

    const source = keyToFields.get(condition.fieldKey)?.[0];

    if (!source) {
      if (strict) {
        errors.push({
          fieldId: field.id,
          message: `The condition of ${name} uses the field key "${condition.fieldKey}", but no field has that key.`,
        });
      }

      continue;
    }

    if (source.id === field.id) {
      errors.push({ fieldId: field.id, message: `The condition of ${name} cannot use the field itself.` });
      continue;
    }

    if (source.recipientId !== field.recipientId) {
      errors.push({
        fieldId: field.id,
        message: `The condition of ${name} uses "${condition.fieldKey}", which belongs to another recipient. A condition can only use fields of the same recipient.`,
      });
      continue;
    }

    if (source.envelopeItemId !== field.envelopeItemId) {
      errors.push({
        fieldId: field.id,
        message: `The condition of ${name} uses "${condition.fieldKey}", which is on another document. A condition can only use fields on the same document.`,
      });
      continue;
    }

    const optionValues = getOptionValues(source.fieldMeta);

    if (condition.operator === 'checked' || condition.operator === 'notChecked') {
      if (!OPTION_FIELD_TYPES.includes(source.type)) {
        errors.push({
          fieldId: field.id,
          message: `The condition of ${name} uses "is checked" or "is not checked", so "${condition.fieldKey}" must be a checkbox or radio field.`,
        });
        continue;
      }

      if (condition.value && !optionValues.includes(condition.value)) {
        errors.push({
          fieldId: field.id,
          message: `The condition of ${name} uses the option "${condition.value}", which "${condition.fieldKey}" does not have.`,
        });
      }
    }

    if (condition.operator === 'equals') {
      if (NO_VALUE_FIELD_TYPES.includes(source.type)) {
        errors.push({
          fieldId: field.id,
          message: `The condition of ${name} compares "${condition.fieldKey}" with a value, but a signature has no value to compare. Use "is not empty".`,
        });
        continue;
      }

      if (!condition.value?.trim()) {
        errors.push({ fieldId: field.id, message: `The condition of ${name} needs a value to compare with.` });
        continue;
      }

      const hasOptions = OPTION_FIELD_TYPES.includes(source.type) || source.type === FieldType.DROPDOWN;

      if (hasOptions && !optionValues.includes(condition.value)) {
        errors.push({
          fieldId: field.id,
          message: `The condition of ${name} uses the option "${condition.value}", which "${condition.fieldKey}" does not have.`,
        });
      }
    }
  }

  for (const field of fields) {
    const rawFormula = asRecord(field.fieldMeta)?.formula;

    if (rawFormula === undefined || rawFormula === null || rawFormula === '') {
      continue;
    }

    const name = describeFieldForLogic(field);

    if (field.type !== FieldType.NUMBER || typeof rawFormula !== 'string') {
      errors.push({ fieldId: field.id, message: `Only number fields can have a formula; ${name} cannot.` });
      continue;
    }

    const parsed = parseFormula(rawFormula);

    if (!parsed.success) {
      errors.push({ fieldId: field.id, message: `The formula of ${name} is not valid: ${parsed.error}` });
      continue;
    }

    const { fieldKey } = readFieldLogicMeta(field.fieldMeta);

    for (const reference of parsed.references) {
      const source = keyToFields.get(reference)?.[0];

      if (!source) {
        if (strict) {
          errors.push({
            fieldId: field.id,
            message: `The formula of ${name} uses the field key "${reference}", but no field has that key.`,
          });
        }

        continue;
      }

      if (reference === fieldKey) {
        errors.push({ fieldId: field.id, message: `The formula of ${name} cannot use the field itself.` });
      } else if (source.recipientId !== field.recipientId) {
        errors.push({
          fieldId: field.id,
          message: `The formula of ${name} uses "${reference}", which belongs to another recipient. A formula can only use fields of the same recipient.`,
        });
      } else if (source.envelopeItemId !== field.envelopeItemId) {
        errors.push({
          fieldId: field.id,
          message: `The formula of ${name} uses "${reference}", which is on another document. A formula can only use fields on the same document.`,
        });
      } else if (source.type !== FieldType.NUMBER) {
        errors.push({
          fieldId: field.id,
          message: `The formula of ${name} uses "${reference}", which is not a number field.`,
        });
      }
    }
  }

  const groups = new Map<string, FieldLogicDefinition[]>();

  for (const field of fields) {
    const groupKey = getFieldLogicGroupKey(field);

    groups.set(groupKey, [...(groups.get(groupKey) ?? []), field]);
  }

  for (const group of groups.values()) {
    const cycleIds = findFieldLogicCycleIds(group.map((field) => ({ ...field, inserted: false, customText: '' })));

    for (const field of group) {
      const dependsOnItself = getFieldLogicDependencies(field.fieldMeta).includes(
        readFieldLogicMeta(field.fieldMeta).fieldKey ?? '',
      );

      if (cycleIds.has(field.id) && !dependsOnItself) {
        errors.push({
          fieldId: field.id,
          message: `${describeFieldForLogic(field)} is part of a loop: its rules depend on each other in a circle.`,
        });
      }
    }
  }

  return errors;
};

/**
 * One sentence per problem: a duplicate key is reported on each field that has it, but the
 * refusal says it once.
 */
export const formatFieldLogicErrors = (errors: FieldLogicError[]) =>
  [...new Set(errors.map((error) => error.message))].join(' ');

/**
 * The problems a change would add. The editor keeps a change that adds one local (with the
 * message next to the field) instead of saving it, so a refusal never reaches the server as
 * a failed save.
 */
export const findNewFieldLogicErrors = (before: FieldLogicDefinition[], after: FieldLogicDefinition[]) => {
  const existing = new Set(validateFieldLogic(before).map((error) => error.message));

  return [...new Set(validateFieldLogic(after).map((error) => error.message))].filter(
    (message) => !existing.has(message),
  );
};
