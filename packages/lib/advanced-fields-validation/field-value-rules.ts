import { checkboxValidationSigns } from '@documenso/ui/primitives/document-flow/field-items-advanced-settings/constants';
import { FieldType } from '@prisma/client';

import {
  ZCheckboxFieldMeta,
  ZDropdownFieldMeta,
  ZFieldMetaSchema,
  ZNumberFieldMeta,
  ZRadioFieldMeta,
  ZTextFieldMeta,
} from '../types/field-meta';
import { zEmail } from '../utils/zod';
import { validateCheckboxLength } from './validate-checkbox';
import { validateNumberField } from './validate-number';
import { validateTextField } from './validate-text';

/**
 * Solid Ten Sign (L round 2): THE value rules for a signer's field value, the same on every route
 * that takes one: version-1 signing (field.signFieldWithToken), version-2 signing
 * (envelope.field.sign; in-person signing uses it too), direct links and public forms
 * (createDocumentFromDirectTemplate). Each route turns its own input into one string at its edge
 * and says which representation its envelope stores:
 *
 * - `option-value` (version-1 envelopes): radio = the option's text (`empty-value-<id>` for an
 *   option without text, as the page sends it); checkbox = a JSON list of those, e.g. ["A","B"].
 * - `option-index` (version-2 envelopes): radio = the option index as a plain number ("0", "1",
 *   not "01" or " 1"); checkbox = a JSON list of index numbers, e.g. [0,2] (not ["0","2"]).
 *
 * Result:
 * - `empty`: nothing filled in (no value, blank, or an empty checkbox list). Allowed for an
 *   optional field (the route stores it as not filled, as before); a required field is refused
 *   here, the same outcome the completion check gives (isRequiredField; a field hidden by field
 *   logic is not required: the caller says so).
 * - `ok`, or `refused` with a plain reason.
 *
 * A read-only field takes only its preset value (nothing sent counts as not filled). Stored old
 * values are never re-checked (completion does not use this).
 */
export type TValueRepresentation = 'option-value' | 'option-index';

export type TFieldValueCheck = { result: 'empty' } | { result: 'ok' } | { result: 'refused'; reason: string };

export const representationForVersion = (internalVersion: number): TValueRepresentation =>
  internalVersion === 2 ? 'option-index' : 'option-value';

export type TCheckFieldValueOptions = {
  field: { type: FieldType; fieldMeta: unknown };
  /** The submitted value as one string (null/undefined: nothing submitted). */
  value: string | null | undefined;
  representation: TValueRepresentation;
  /** Whether the field must be filled (isRequiredField, unless field logic hides it). */
  isRequired: boolean;
  /** For signature fields: true for a drawn or uploaded image, false for a typed name. */
  isBase64?: boolean;
  /** The document's setting; false refuses a typed signature. */
  typedSignatureEnabled?: boolean | null;
};

const REQUIRED_REASON = 'This field is required.';
const NOT_AN_OPTION = 'The chosen value is not one of the options of this field.';

const refused = (reason: string): TFieldValueCheck => ({ result: 'refused', reason });
const OK: TFieldValueCheck = { result: 'ok' };
const EMPTY: TFieldValueCheck = { result: 'empty' };

const CANONICAL_INDEX = /^(0|[1-9]\d*)$/;

/** The value the version-1 page sends for an option (document-signing-radio-field.tsx). */
const optionValue = (option: { id: number; value: string }) =>
  option.value.length > 0 ? option.value : `empty-value-${option.id}`;

type TChoice = { id: number; checked: boolean; value: string };

/** The chosen options of a checkbox value in this representation, or null when not well formed. */
const parseCheckboxChoice = (
  value: string,
  options: TChoice[],
  representation: TValueRepresentation,
): number[] | 'malformed' | 'not-an-option' => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(value);
  } catch {
    return 'malformed';
  }

  if (!Array.isArray(parsed)) {
    return 'malformed';
  }

  const indexes: number[] = [];

  for (const item of parsed) {
    if (representation === 'option-index') {
      if (typeof item !== 'number' || !Number.isInteger(item) || item < 0) {
        return 'malformed';
      }

      if (item >= options.length) {
        return 'not-an-option';
      }

      indexes.push(item);
    } else {
      if (typeof item !== 'string') {
        return 'malformed';
      }

      const index = options.findIndex((option) => optionValue(option) === item);

      if (index === -1) {
        return 'not-an-option';
      }

      indexes.push(index);
    }
  }

  return indexes;
};

/** The radio option a value names in this representation, or -1. */
const parseRadioChoice = (value: string, options: TChoice[], representation: TValueRepresentation) => {
  if (representation === 'option-index') {
    return CANONICAL_INDEX.test(value) && Number(value) < options.length ? Number(value) : -1;
  }

  return options.findIndex((option) => optionValue(option) === value);
};

const isEmptyValue = (type: FieldType, value: string | null | undefined) => {
  if (value === null || value === undefined || value.trim() === '') {
    return true;
  }

  return type === FieldType.CHECKBOX && value.trim() === '[]';
};

/** A read-only field's preset value check (before anything else). */
const checkReadOnly = (
  field: TCheckFieldValueOptions['field'],
  value: string | null | undefined,
  representation: TValueRepresentation,
): TFieldValueCheck | null => {
  const meta = ZFieldMetaSchema.safeParse(field.fieldMeta);

  if (!meta.success || !meta.data || !('readOnly' in meta.data) || !meta.data.readOnly) {
    return null;
  }

  // Nothing sent for a read-only field: not filled (a page may leave it out). Only a value that
  // differs from the preset is refused.
  if (isEmptyValue(field.type, value)) {
    return EMPTY;
  }

  const given = value ?? '';
  const data = meta.data;

  const matches = (() => {
    switch (data.type) {
      case 'text':
        return given === (data.text ?? '');
      case 'number':
        return given === (data.value ?? '');
      case 'dropdown':
        return given === (data.defaultValue ?? '');
      case 'radio': {
        const options = data.values ?? [];
        const preset = options.findIndex((option) => option.checked);

        return preset !== -1 && parseRadioChoice(given, options, representation) === preset;
      }
      case 'checkbox': {
        const options = data.values ?? [];
        const preset = options.flatMap((option, index) => (option.checked ? [index] : []));
        const chosen = given ? parseCheckboxChoice(given, options, representation) : [];

        return (
          Array.isArray(chosen) && chosen.length === preset.length && preset.every((index) => chosen.includes(index))
        );
      }
      default:
        return true;
    }
  })();

  return matches ? OK : refused('This field is read-only and only takes its preset value.');
};

export const checkFieldValue = ({
  field,
  value,
  representation,
  isRequired,
  isBase64,
  typedSignatureEnabled,
}: TCheckFieldValueOptions): TFieldValueCheck => {
  const readOnly = checkReadOnly(field, value, representation);

  if (readOnly) {
    return readOnly;
  }

  if (isEmptyValue(field.type, value)) {
    return isRequired ? refused(REQUIRED_REASON) : EMPTY;
  }

  const given = value as string;

  switch (field.type) {
    case FieldType.SIGNATURE:
    case FieldType.FREE_SIGNATURE:
      if (typedSignatureEnabled === false && !isBase64) {
        return refused('Typed signatures are not allowed. Please draw your signature.');
      }

      return OK;

    case FieldType.RADIO: {
      const meta = ZRadioFieldMeta.safeParse(field.fieldMeta ?? { type: 'radio' });
      const options = meta.success ? (meta.data.values ?? []) : [];

      return parseRadioChoice(given, options, representation) === -1 ? refused(NOT_AN_OPTION) : OK;
    }

    case FieldType.CHECKBOX: {
      const meta = ZCheckboxFieldMeta.safeParse(field.fieldMeta ?? { type: 'checkbox' });
      const options = meta.success ? (meta.data.values ?? []) : [];
      const chosen = parseCheckboxChoice(given, options, representation);

      if (chosen === 'malformed') {
        return refused('The checkbox value is not in the expected form.');
      }

      if (chosen === 'not-an-option') {
        return refused('A chosen value is not one of the options of this field.');
      }

      if (new Set(chosen).size !== chosen.length) {
        return refused('An option is chosen more than once.');
      }

      const rule = meta.success ? meta.data.validationRule : undefined;
      const length = meta.success ? meta.data.validationLength : undefined;
      const sign = checkboxValidationSigns.find((candidate) => candidate.label === rule)?.value as
        | '>='
        | '='
        | '<='
        | undefined;

      if (sign && length && !validateCheckboxLength(chosen.length, sign, length)) {
        return refused(`You need to ${(rule ?? '').toLowerCase()} ${length} options.`);
      }

      return OK;
    }

    case FieldType.DROPDOWN: {
      const meta = ZDropdownFieldMeta.safeParse(field.fieldMeta ?? { type: 'dropdown' });
      const options = meta.success ? (meta.data.values ?? []) : [];

      return options.some((option) => option.value === given) ? OK : refused(NOT_AN_OPTION);
    }

    case FieldType.NUMBER: {
      const meta = ZNumberFieldMeta.safeParse(field.fieldMeta ?? { type: 'number' });
      const errors = validateNumberField(given, meta.success ? meta.data : undefined, true);

      return errors.length > 0 ? refused(errors.join(', ')) : OK;
    }

    case FieldType.TEXT: {
      const meta = ZTextFieldMeta.safeParse(field.fieldMeta ?? { type: 'text' });
      const errors = meta.success ? validateTextField(given, meta.data, true) : [];

      return errors.length > 0 ? refused(errors.join(', ')) : OK;
    }

    case FieldType.EMAIL:
      // The app's email rule and length limit (recipients use the same).
      return zEmail().max(254).safeParse(given.trim()).success
        ? OK
        : refused('The value is not a valid email address.');

    default:
      // Name, initials (not empty, checked above), date (the server writes it), file (own route).
      return OK;
  }
};
