import type { TNumberFieldMeta as NumberFieldMeta } from '../types/field-meta';
import { checkNumberInput, describeNumberInputProblem, parseFieldNumberValue } from '../utils/field-number-value';

export const validateNumberField = (
  value: string,
  fieldMeta?: NumberFieldMeta,
  isSigningPage: boolean = false,
): string[] => {
  const errors = [];

  const { minValue, maxValue, readOnly, required, numberFormat, fontSize } = fieldMeta || {};

  // Solid Ten: the one grammar per format (see `field-number-value.ts`).
  const inputProblem = value.length > 0 ? checkNumberInput(value, numberFormat) : null;

  if (inputProblem) {
    errors.push(describeNumberInputProblem(value, numberFormat, inputProblem));
  }

  const numberValue = parseFieldNumberValue(value, numberFormat) ?? parseFloat(value);

  if (isSigningPage && required && !value) {
    errors.push('Value is required');
  }

  if (typeof minValue === 'number' && minValue > 0 && numberValue < minValue) {
    errors.push(`Value ${value} is less than the minimum value of ${minValue}`);
  }

  if (typeof maxValue === 'number' && maxValue > 0 && numberValue > maxValue) {
    errors.push(`Value ${value} is greater than the maximum value of ${maxValue}`);
  }

  if (typeof minValue === 'number' && typeof maxValue === 'number' && minValue > maxValue) {
    errors.push('Minimum value cannot be greater than maximum value');
  }

  if (typeof maxValue === 'number' && typeof minValue === 'number' && maxValue < minValue) {
    errors.push('Maximum value cannot be less than minimum value');
  }

  if (readOnly && numberValue < 1) {
    errors.push('A read-only field must have a value greater than 0');
  }

  if (readOnly && required) {
    errors.push('A field cannot be both read-only and required');
  }

  if (fontSize && (fontSize < 8 || fontSize > 96)) {
    errors.push('Font size must be between 8 and 96.');
  }

  return errors;
};
