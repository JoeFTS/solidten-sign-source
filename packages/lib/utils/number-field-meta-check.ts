import { FieldType } from '@prisma/client';

import {
  checkNumberInput,
  describeNumberInputProblem,
  isKnownNumberFormat,
  NUMBER_FORMATS,
} from './field-number-value';

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/**
 * Check the number settings a sender or the API stores on a NUMBER field: the number format
 * must be one we know, and a default or prefilled value must match it exactly (same grammar
 * as signer input). Returns the problem as a sentence that names the field, or null.
 */
export const findNumberFieldMetaProblem = (field: { id?: number | null; type: string; fieldMeta?: unknown }) => {
  if (field.type !== FieldType.NUMBER) {
    return null;
  }

  const meta = asRecord(field.fieldMeta);

  if (!meta) {
    return null;
  }

  // Unsaved fields have no id (or a negative stand-in), so they are only named by label.
  const hasId = typeof field.id === 'number' && field.id > 0;
  const label =
    typeof meta.label === 'string' && meta.label.trim()
      ? `"${meta.label.trim()}"`
      : hasId
        ? `with id ${field.id}`
        : 'without a label';
  const numberFormat = typeof meta.numberFormat === 'string' && meta.numberFormat ? meta.numberFormat : null;

  if (numberFormat && !isKnownNumberFormat(numberFormat)) {
    return `The number field ${label} has an unknown number format "${numberFormat}". Use one of: ${NUMBER_FORMATS.join(', ')}.`;
  }

  const value = typeof meta.value === 'string' ? meta.value.trim() : '';

  if (!value) {
    return null;
  }

  const problem = checkNumberInput(value, numberFormat);

  return problem ? `The number field ${label}: ${describeNumberInputProblem(value, numberFormat, problem)}` : null;
};
