import { type Field, FieldType } from '@prisma/client';

import { type TFieldCondition, ZFieldConditionSchema, ZFieldKeySchema } from '../types/field-logic';
import { isRequiredField } from './advanced-fields-helpers';
import {
  evaluateFormulaWithReason,
  type FormulaEmptyReason,
  formatCalculatedValue,
  parseFormula,
} from './field-formula';
import { parseFieldNumberValue } from './field-number-value';

export type FieldLogicInput = Pick<
  Field,
  'id' | 'type' | 'recipientId' | 'envelopeItemId' | 'inserted' | 'customText'
> & {
  fieldMeta?: unknown;
};

export type FieldLogicState = {
  isHidden: boolean;
  /**
   * For a field with a formula: the value as text, '' when it is empty. Null for every
   * other field.
   */
  calculatedValue: string | null;
  calculatedNumber: number | null;
  /**
   * Why a calculated field is empty, with the keys of the empty sources; null when it has
   * a value or is not calculated.
   */
  calculatedEmptyReason?: FormulaEmptyReason | null;
  missingSourceKeys?: string[];
};

export type FieldLogicMeta = {
  fieldKey: string | null;
  condition: TFieldCondition | null;
  /**
   * Only number fields can be calculated.
   */
  formula: string | null;
  /**
   * Count empty, hidden or missing sources as 0 instead of leaving the result empty.
   */
  formulaEmptySourcesAsZero: boolean;
};

type FieldSourceValue = {
  hasValue: boolean;
  text: string;
  selectedOptions: string[] | null;
};

const EMPTY_SOURCE_VALUE: FieldSourceValue = { hasValue: false, text: '', selectedOptions: null };

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/**
 * Read the logic keys from a stored field meta. Malformed values are ignored, so a bad
 * row can never crash signing; save-time validation keeps them out in the first place.
 */
export const readFieldLogicMeta = (fieldMeta: unknown): FieldLogicMeta => {
  const meta = asRecord(fieldMeta);

  const fieldKey = ZFieldKeySchema.safeParse(meta?.fieldKey);
  const condition = ZFieldConditionSchema.safeParse(meta?.condition);
  const formula =
    meta?.type === 'number' && typeof meta.formula === 'string' && meta.formula.trim() ? meta.formula : null;

  return {
    fieldKey: fieldKey.success ? fieldKey.data : null,
    condition: condition.success ? condition.data : null,
    formula,
    formulaEmptySourcesAsZero: Boolean(formula) && meta?.formulaEmptySourcesAsZero === true,
  };
};

const FIELD_LOGIC_META_KEYS = ['fieldKey', 'condition', 'formula', 'formulaEmptySourcesAsZero'] as const;

export const isCalculatedField = (field: { fieldMeta?: unknown }) =>
  readFieldLogicMeta(field.fieldMeta).formula !== null;

export const fieldUsesLogic = (fieldMeta: unknown) => {
  const meta = asRecord(fieldMeta);

  return Boolean(
    meta && FIELD_LOGIC_META_KEYS.some((key) => meta[key] !== undefined && meta[key] !== null && meta[key] !== false),
  );
};

/**
 * A stable string of the logic keys, to compare two versions of a field.
 */
export const readFieldLogicKeys = (fieldMeta: unknown) => {
  const meta = asRecord(fieldMeta);

  return JSON.stringify(FIELD_LOGIC_META_KEYS.map((key) => meta?.[key] ?? null));
};

/**
 * Copy the logic keys of `previous` onto `next` when `next` does not set them. The
 * per-type editor forms emit only the keys they own, which would otherwise drop the rules.
 */
export const keepFieldLogicMeta = <T>(previous: unknown, next: T): T => {
  const previousMeta = asRecord(previous);
  const nextMeta = asRecord(next);

  if (!previousMeta || !nextMeta) {
    return next;
  }

  const kept: Record<string, unknown> = {};

  for (const key of FIELD_LOGIC_META_KEYS) {
    if (!(key in nextMeta) && previousMeta[key] !== undefined) {
      kept[key] = previousMeta[key];
    }
  }

  return { ...nextMeta, ...kept } as T;
};

export const getFieldLogicDependencies = (fieldMeta: unknown): string[] => {
  const { condition, formula } = readFieldLogicMeta(fieldMeta);

  const dependencies = condition ? [condition.fieldKey] : [];

  if (formula) {
    const parsed = parseFormula(formula);

    if (parsed.success) {
      dependencies.push(...parsed.references);
    }
  }

  return dependencies;
};

/**
 * Conditions and formulas only reach fields of the same recipient on the same document.
 */
export const getFieldLogicGroupKey = (field: Pick<FieldLogicInput, 'recipientId' | 'envelopeItemId'>) =>
  `${field.recipientId ?? 'none'}:${field.envelopeItemId}`;

const getOptionValues = (fieldMeta: unknown): string[] => {
  const values = asRecord(fieldMeta)?.values;

  if (!Array.isArray(values)) {
    return [];
  }

  return values.map((option) => {
    const value = asRecord(option)?.value;

    return typeof value === 'string' ? value : '';
  });
};

const parseSelectedIndexes = (field: FieldLogicInput): number[] => {
  if (field.type === FieldType.RADIO) {
    const index = Number(field.customText);

    return Number.isInteger(index) ? [index] : [];
  }

  try {
    const parsed: unknown = JSON.parse(field.customText || '[]');

    return Array.isArray(parsed) ? parsed.filter((index): index is number => Number.isInteger(index)) : [];
  } catch {
    return [];
  }
};

const readStoredSourceValue = (field: FieldLogicInput): FieldSourceValue => {
  if (!field.inserted) {
    return EMPTY_SOURCE_VALUE;
  }

  if (field.type === FieldType.CHECKBOX || field.type === FieldType.RADIO) {
    const optionValues = getOptionValues(field.fieldMeta);

    const selectedOptions = parseSelectedIndexes(field)
      .filter((index) => index >= 0 && index < optionValues.length)
      .map((index) => optionValues[index]);

    return {
      hasValue: selectedOptions.length > 0,
      text: selectedOptions.join(', '),
      selectedOptions,
    };
  }

  if (field.type === FieldType.SIGNATURE || field.type === FieldType.FREE_SIGNATURE) {
    return { hasValue: true, text: '', selectedOptions: null };
  }

  const text = field.customText.trim();

  return { hasValue: text.length > 0, text, selectedOptions: null };
};

const readSourceValue = (source: FieldLogicInput, sourceState: FieldLogicState): FieldSourceValue => {
  if (sourceState.isHidden) {
    return EMPTY_SOURCE_VALUE;
  }

  if (sourceState.calculatedValue !== null) {
    return { hasValue: sourceState.calculatedValue !== '', text: sourceState.calculatedValue, selectedOptions: null };
  }

  return readStoredSourceValue(source);
};

const readNumberFormat = (fieldMeta: unknown) => {
  const numberFormat = asRecord(fieldMeta)?.numberFormat;

  return typeof numberFormat === 'string' ? numberFormat : null;
};

/**
 * The number a formula sees for a source: hidden, empty, non-number and unparsable
 * sources are missing (null).
 */
const readSourceNumber = (source: FieldLogicInput, sourceState: FieldLogicState): number | null => {
  if (sourceState.isHidden || source.type !== FieldType.NUMBER) {
    return null;
  }

  if (sourceState.calculatedValue !== null) {
    return sourceState.calculatedNumber;
  }

  if (!source.inserted) {
    return null;
  }

  return parseFieldNumberValue(source.customText, readNumberFormat(source.fieldMeta));
};

const valuesAreEqual = (source: FieldLogicInput, sourceValue: FieldSourceValue, expected: string) => {
  if (sourceValue.selectedOptions) {
    return sourceValue.selectedOptions.includes(expected);
  }

  if (source.type === FieldType.NUMBER) {
    const format = readNumberFormat(source.fieldMeta);

    const left = parseFieldNumberValue(sourceValue.text, format);
    const right = parseFieldNumberValue(expected, format);

    if (left !== null && right !== null) {
      return left === right;
    }
  }

  return sourceValue.text === expected.trim();
};

/**
 * Evaluate one condition against its source field.
 *
 * - A source that does not exist (deleted, another recipient, another document) makes the
 *   condition false, so the dependent field stays hidden.
 * - A source that exists but is itself hidden counts as empty and unchecked.
 */
export const evaluateFieldCondition = (
  condition: TFieldCondition,
  source: FieldLogicInput | undefined,
  sourceState: FieldLogicState | undefined,
): boolean => {
  if (!source || !sourceState) {
    return false;
  }

  const sourceValue = readSourceValue(source, sourceState);

  switch (condition.operator) {
    case 'checked':
    case 'notChecked': {
      const isChecked = condition.value
        ? (sourceValue.selectedOptions ?? []).includes(condition.value)
        : (sourceValue.selectedOptions ?? []).length > 0;

      return condition.operator === 'checked' ? isChecked : !isChecked;
    }
    case 'equals':
      return (
        sourceValue.hasValue && condition.value !== undefined && valuesAreEqual(source, sourceValue, condition.value)
      );
    case 'notEmpty':
      return sourceValue.hasValue;
  }
};

/**
 * Return the ids of fields that sit on a dependency cycle inside one group.
 */
export const findFieldLogicCycleIds = (fields: FieldLogicInput[]): Set<number> => {
  const keyToField = new Map<string, FieldLogicInput>();

  for (const field of fields) {
    const { fieldKey } = readFieldLogicMeta(field.fieldMeta);

    if (fieldKey && !keyToField.has(fieldKey)) {
      keyToField.set(fieldKey, field);
    }
  }

  const cycleIds = new Set<number>();
  const done = new Set<number>();
  const stack: number[] = [];
  const onStack = new Set<number>();

  const visit = (field: FieldLogicInput) => {
    if (done.has(field.id)) {
      return;
    }

    if (onStack.has(field.id)) {
      const start = stack.indexOf(field.id);

      for (const id of stack.slice(start)) {
        cycleIds.add(id);
      }

      return;
    }

    onStack.add(field.id);
    stack.push(field.id);

    for (const key of getFieldLogicDependencies(field.fieldMeta)) {
      const dependency = keyToField.get(key);

      if (dependency) {
        visit(dependency);
      }
    }

    stack.pop();
    onStack.delete(field.id);
    done.add(field.id);
  };

  for (const field of fields) {
    visit(field);
  }

  return cycleIds;
};

/**
 * Resolve whether each field is shown, and the value of each calculated field, from the
 * current field values.
 *
 * Pure and deterministic, so the browser preview, the sign route, the complete route and
 * the seal job all reach the same answer from the same rows. Fields on a dependency
 * cycle are hidden and empty; save-time validation rejects cycles, this only keeps
 * runtime safe.
 */
export const resolveFieldLogic = (fields: FieldLogicInput[]): Map<number, FieldLogicState> => {
  const states = new Map<number, FieldLogicState>();

  const groups = new Map<string, FieldLogicInput[]>();

  for (const field of fields) {
    const groupKey = getFieldLogicGroupKey(field);
    const group = groups.get(groupKey) ?? [];

    group.push(field);
    groups.set(groupKey, group);
  }

  for (const group of groups.values()) {
    const keyToField = new Map<string, FieldLogicInput>();

    for (const field of group) {
      const { fieldKey } = readFieldLogicMeta(field.fieldMeta);

      if (fieldKey && !keyToField.has(fieldKey)) {
        keyToField.set(fieldKey, field);
      }
    }

    const cycleIds = findFieldLogicCycleIds(group);

    const resolve = (field: FieldLogicInput): FieldLogicState => {
      const cached = states.get(field.id);

      if (cached) {
        return cached;
      }

      const { condition, formula, formulaEmptySourcesAsZero } = readFieldLogicMeta(field.fieldMeta);

      if (cycleIds.has(field.id)) {
        const cycleState = { isHidden: true, calculatedValue: formula ? '' : null, calculatedNumber: null };

        states.set(field.id, cycleState);

        return cycleState;
      }

      let isHidden = false;

      if (condition) {
        const source = keyToField.get(condition.fieldKey);
        const sourceState = source && source.id !== field.id ? resolve(source) : undefined;

        isHidden = !evaluateFieldCondition(condition, source?.id === field.id ? undefined : source, sourceState);
      }

      let calculatedNumber: number | null = null;
      let calculatedValue: string | null = null;
      let calculatedEmptyReason: FormulaEmptyReason | null = null;
      let missingSourceKeys: string[] = [];

      if (formula) {
        const parsed = parseFormula(formula);

        if (parsed.success && !isHidden) {
          const evaluation = evaluateFormulaWithReason(parsed.ast, (key) => {
            const source = keyToField.get(key);
            const sourceNumber = source && source.id !== field.id ? readSourceNumber(source, resolve(source)) : null;

            return sourceNumber === null && formulaEmptySourcesAsZero ? 0 : sourceNumber;
          });

          calculatedNumber = evaluation.value;
          calculatedEmptyReason = evaluation.reason;
          missingSourceKeys = evaluation.missingKeys;
        }

        calculatedValue = formatCalculatedValue(calculatedNumber, readNumberFormat(field.fieldMeta));
      }

      const state = { isHidden, calculatedValue, calculatedNumber, calculatedEmptyReason, missingSourceKeys };

      states.set(field.id, state);

      return state;
    };

    for (const field of group) {
      resolve(field);
    }
  }

  return states;
};

export const getHiddenFieldIds = (fields: FieldLogicInput[]): Set<number> => {
  const hiddenIds = new Set<number>();

  for (const [id, state] of resolveFieldLogic(fields)) {
    if (state.isHidden) {
      hiddenIds.add(id);
    }
  }

  return hiddenIds;
};

/**
 * Remove the fields whose condition is false. `fields` must contain every field the
 * conditions can reach (all fields of the recipient on the document).
 */
export const filterVisibleFields = <T extends FieldLogicInput>(fields: T[]): T[] => {
  const hiddenIds = getHiddenFieldIds(fields);

  return fields.filter((field) => !hiddenIds.has(field.id));
};

/**
 * The rule-aware version of `fieldsContainUnsignedRequiredField`. Hidden fields are never
 * required, and calculated fields are filled by the server, not by the signer.
 */
export const fieldsContainUnsignedRequiredVisibleField = (fields: Field[]) =>
  filterVisibleFields(fields).some((field) => !isCalculatedField(field) && isRequiredField(field) && !field.inserted);

/**
 * Remove, in place, the send-time auto-inserts of signer-editable fields that are hidden
 * once the auto-inserted values are applied. Read-only fields keep theirs: the signer can
 * never type them, so the value must already be there if the field is shown later.
 */
export const dropAutoInsertsOfHiddenFields = (
  fields: FieldLogicInput[],
  autoInserts: { fieldId: number; customText: string }[],
) => {
  const simulatedFields = fields.map((field) => {
    const autoInsert = autoInserts.find((insert) => insert.fieldId === field.id);

    return autoInsert ? { ...field, customText: autoInsert.customText, inserted: true } : field;
  });

  const hiddenIds = getHiddenFieldIds(simulatedFields);

  for (let index = autoInserts.length - 1; index >= 0; index--) {
    const field = fields.find((candidate) => candidate.id === autoInserts[index].fieldId);

    if (field && hiddenIds.has(field.id) && asRecord(field.fieldMeta)?.readOnly !== true) {
      autoInserts.splice(index, 1);
    }
  }
};

/**
 * What a signer's change to one field would clear: the fields that are shown and filled
 * now but would be hidden after the change. The server clears them (and deletes their
 * files), so the signing page asks first. Read-only and calculated fields are not counted:
 * the signer never typed them.
 */
export const findValuesClearedByChange = <T extends FieldLogicInput>(
  fields: T[],
  fieldId: number,
  change: { customText: string; inserted: boolean },
): { fields: T[]; answerCount: number; fileCount: number } => {
  const before = resolveFieldLogic(fields);
  const after = resolveFieldLogic(fields.map((field) => (field.id === fieldId ? { ...field, ...change } : field)));

  const cleared = fields.filter(
    (field) =>
      field.id !== fieldId &&
      field.inserted &&
      asRecord(field.fieldMeta)?.readOnly !== true &&
      !isCalculatedField(field) &&
      !before.get(field.id)?.isHidden &&
      after.get(field.id)?.isHidden,
  );

  const fileFields = cleared.filter((field) => field.type === FieldType.FILE);

  return {
    fields: cleared,
    answerCount: cleared.length - fileFields.length,
    // A file field's text is the list of its file names, joined by ", ".
    fileCount: fileFields.reduce((count, field) => count + Math.max(1, field.customText.split(', ').length), 0),
  };
};

/**
 * For the signing page renderer: which drawn fields are no longer shown, and which shown
 * fields changed their label (the hint on an empty calculated field) since they were drawn.
 */
export const diffRenderedFields = (
  renderedFields: Map<number, { fieldMeta?: unknown }>,
  visibleFields: { id: number; fieldMeta?: unknown }[],
) => {
  const removedIds: number[] = [];
  const changedIds: number[] = [];

  for (const [fieldId, rendered] of renderedFields) {
    const visible = visibleFields.find((field) => field.id === fieldId);

    if (!visible) {
      removedIds.push(fieldId);
    } else if (asRecord(rendered.fieldMeta)?.label !== asRecord(visible.fieldMeta)?.label) {
      changedIds.push(fieldId);
    }
  }

  return { removedIds, changedIds };
};
