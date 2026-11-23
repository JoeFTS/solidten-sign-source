import { FieldType } from '@prisma/client';

import type { TValueRepresentation } from '../field-value-rules';

/**
 * Solid Ten Sign (L round 2): one matrix of (field type × value × required/optional × read-only)
 * for the value rules. The unit test runs it against checkFieldValue; the route test
 * (e2e/solidten/field-value-routes.spec.ts) runs the same rows against every route that takes a
 * value, with the expected outcome taken from here.
 *
 * `values` gives the value in each representation (version-1 option values, version-2 option
 * indexes); a row without a value for a representation does not apply to it. `''` is what the
 * version-2 direct-link and public-form pages send for a field the visitor did not touch.
 */
export type TMatrixExpect = 'ok' | 'empty' | 'refused';

export type TMatrixRow = {
  name: string;
  type: FieldType;
  meta: Record<string, unknown> | null;
  values: Partial<Record<TValueRepresentation, string>>;
  expect: TMatrixExpect;
  /** Signature rows: false refuses a typed signature. */
  typedSignatureEnabled?: boolean;
};

const radio = (extra: Record<string, unknown> = {}) => ({
  type: 'radio',
  values: [
    { id: 1, checked: false, value: 'Yes' },
    { id: 2, checked: false, value: 'No' },
  ],
  ...extra,
});

const checkbox = (extra: Record<string, unknown> = {}) => ({
  type: 'checkbox',
  values: [
    { id: 1, checked: false, value: 'A' },
    { id: 2, checked: false, value: 'B' },
    { id: 3, checked: false, value: 'C' },
  ],
  validationRule: 'Select at least',
  validationLength: 2,
  ...extra,
});

const dropdown = (extra: Record<string, unknown> = {}) => ({
  type: 'dropdown',
  values: [{ value: 'Lunch' }, { value: 'Dinner' }],
  ...extra,
});

const both = (value: string) => ({ 'option-value': value, 'option-index': value });

export const FIELD_VALUE_MATRIX: TMatrixRow[] = [
  // Radio.
  { name: 'radio optional, untouched ""', type: FieldType.RADIO, meta: radio(), values: both(''), expect: 'empty' },
  {
    name: 'radio required, untouched ""',
    type: FieldType.RADIO,
    meta: radio({ required: true }),
    values: both(''),
    expect: 'refused',
  },
  {
    name: 'radio, an option',
    type: FieldType.RADIO,
    meta: radio({ required: true }),
    values: { 'option-value': 'Yes', 'option-index': '0' },
    expect: 'ok',
  },
  {
    name: 'radio, not an option',
    type: FieldType.RADIO,
    meta: radio(),
    values: { 'option-value': 'Maybe', 'option-index': '5' },
    expect: 'refused',
  },
  {
    name: 'radio, the other representation',
    type: FieldType.RADIO,
    meta: radio(),
    values: { 'option-value': '0', 'option-index': 'Yes' },
    expect: 'refused',
  },
  {
    name: 'radio, non-canonical index "01"',
    type: FieldType.RADIO,
    meta: radio({ required: true }),
    values: { 'option-index': '01' },
    expect: 'refused',
  },
  // Checkbox ("Select at least 2").
  {
    name: 'checkbox optional, untouched ""',
    type: FieldType.CHECKBOX,
    meta: checkbox(),
    values: both(''),
    expect: 'empty',
  },
  {
    name: 'checkbox required, untouched ""',
    type: FieldType.CHECKBOX,
    meta: checkbox({ required: true }),
    values: both(''),
    expect: 'refused',
  },
  {
    name: 'checkbox, two options',
    type: FieldType.CHECKBOX,
    meta: checkbox({ required: true }),
    values: { 'option-value': '["A","B"]', 'option-index': '[0,1]' },
    expect: 'ok',
  },
  {
    name: 'checkbox, a duplicate beats the count',
    type: FieldType.CHECKBOX,
    meta: checkbox(),
    values: { 'option-value': '["A","A"]', 'option-index': '[0,0]' },
    expect: 'refused',
  },
  {
    name: 'checkbox, too few',
    type: FieldType.CHECKBOX,
    meta: checkbox(),
    values: { 'option-value': '["A"]', 'option-index': '[0]' },
    expect: 'refused',
  },
  {
    name: 'checkbox, not an option',
    type: FieldType.CHECKBOX,
    meta: checkbox(),
    values: { 'option-value': '["A","Z"]', 'option-index': '[0,7]' },
    expect: 'refused',
  },
  {
    name: 'checkbox, the other representation',
    type: FieldType.CHECKBOX,
    meta: checkbox(),
    values: { 'option-value': '[0,1]', 'option-index': '["0","1"]' },
    expect: 'refused',
  },
  { name: 'checkbox, not a list', type: FieldType.CHECKBOX, meta: checkbox(), values: both('A,B'), expect: 'refused' },
  // Dropdown.
  {
    name: 'dropdown optional, untouched ""',
    type: FieldType.DROPDOWN,
    meta: dropdown(),
    values: both(''),
    expect: 'empty',
  },
  {
    name: 'dropdown required, untouched ""',
    type: FieldType.DROPDOWN,
    meta: dropdown({ required: true }),
    values: both(''),
    expect: 'refused',
  },
  { name: 'dropdown, an option', type: FieldType.DROPDOWN, meta: dropdown(), values: both('Dinner'), expect: 'ok' },
  {
    name: 'dropdown, not an option',
    type: FieldType.DROPDOWN,
    meta: dropdown(),
    values: both('Pizza'),
    expect: 'refused',
  },
  // Number (1 to 10).
  {
    name: 'number optional, untouched ""',
    type: FieldType.NUMBER,
    meta: { type: 'number', minValue: 1, maxValue: 10 },
    values: both(''),
    expect: 'empty',
  },
  {
    name: 'number required, untouched ""',
    type: FieldType.NUMBER,
    meta: { type: 'number', required: true, minValue: 1, maxValue: 10 },
    values: both(''),
    expect: 'refused',
  },
  {
    name: 'number in range',
    type: FieldType.NUMBER,
    meta: { type: 'number', minValue: 1, maxValue: 10 },
    values: both('7'),
    expect: 'ok',
  },
  {
    name: 'number out of range',
    type: FieldType.NUMBER,
    meta: { type: 'number', minValue: 1, maxValue: 10 },
    values: both('50'),
    expect: 'refused',
  },
  {
    name: 'number, not a number',
    type: FieldType.NUMBER,
    meta: { type: 'number' },
    values: both('abc'),
    expect: 'refused',
  },
  // Text (limit 10).
  {
    name: 'text optional, untouched ""',
    type: FieldType.TEXT,
    meta: { type: 'text', characterLimit: 10 },
    values: both(''),
    expect: 'empty',
  },
  {
    name: 'text required, untouched ""',
    type: FieldType.TEXT,
    meta: { type: 'text', required: true, characterLimit: 10 },
    values: both(''),
    expect: 'refused',
  },
  {
    name: 'text within the limit',
    type: FieldType.TEXT,
    meta: { type: 'text', characterLimit: 10 },
    values: both('Thanks'),
    expect: 'ok',
  },
  {
    name: 'text over the limit',
    type: FieldType.TEXT,
    meta: { type: 'text', characterLimit: 10 },
    values: both('far too long text'),
    expect: 'refused',
  },
  // Read-only (preset "Main Hall"; radio preset Yes).
  {
    name: 'read-only text, its preset',
    type: FieldType.TEXT,
    meta: { type: 'text', readOnly: true, text: 'Main Hall' },
    values: both('Main Hall'),
    expect: 'ok',
  },
  {
    name: 'read-only text, another value',
    type: FieldType.TEXT,
    meta: { type: 'text', readOnly: true, text: 'Main Hall' },
    values: both('Other Hall'),
    expect: 'refused',
  },
  {
    name: 'read-only text, nothing sent',
    type: FieldType.TEXT,
    meta: { type: 'text', readOnly: true, text: 'Main Hall' },
    values: both(''),
    expect: 'empty',
  },
  {
    name: 'read-only radio, another option',
    type: FieldType.RADIO,
    meta: {
      type: 'radio',
      readOnly: true,
      values: [
        { id: 1, checked: true, value: 'Yes' },
        { id: 2, checked: false, value: 'No' },
      ],
    },
    values: { 'option-value': 'No', 'option-index': '1' },
    expect: 'refused',
  },
  // Email, name, initials, date: always required (no optional setting in the app).
  { name: 'email, untouched ""', type: FieldType.EMAIL, meta: { type: 'email' }, values: both(''), expect: 'refused' },
  {
    name: 'email, an address',
    type: FieldType.EMAIL,
    meta: { type: 'email' },
    values: both('sam@example.com'),
    expect: 'ok',
  },
  {
    name: 'email, not an address',
    type: FieldType.EMAIL,
    meta: { type: 'email' },
    values: both('not an email'),
    expect: 'refused',
  },
  {
    name: 'email, over 254 characters',
    type: FieldType.EMAIL,
    meta: { type: 'email' },
    values: both(`${'a'.repeat(300)}@example.com`),
    expect: 'refused',
  },
  { name: 'name, untouched ""', type: FieldType.NAME, meta: { type: 'name' }, values: both(''), expect: 'refused' },
  { name: 'name, spaces only', type: FieldType.NAME, meta: { type: 'name' }, values: both('   '), expect: 'refused' },
  { name: 'name, a name', type: FieldType.NAME, meta: { type: 'name' }, values: both('Sam Rivera'), expect: 'ok' },
  {
    name: 'initials, untouched ""',
    type: FieldType.INITIALS,
    meta: { type: 'initials' },
    values: both(''),
    expect: 'refused',
  },
  { name: 'initials, a value', type: FieldType.INITIALS, meta: { type: 'initials' }, values: both('SR'), expect: 'ok' },
  { name: 'date, untouched ""', type: FieldType.DATE, meta: { type: 'date' }, values: both(''), expect: 'refused' },
  {
    name: 'date, any value (the server writes the date)',
    type: FieldType.DATE,
    meta: { type: 'date' },
    values: both('2026-11-23'),
    expect: 'ok',
  },
  // Signature (typed).
  {
    name: 'signature, untouched ""',
    type: FieldType.SIGNATURE,
    meta: { type: 'signature' },
    values: both(''),
    expect: 'refused',
  },
  {
    name: 'signature, typed',
    type: FieldType.SIGNATURE,
    meta: { type: 'signature' },
    values: both('Sam Rivera'),
    expect: 'ok',
  },
  {
    name: 'signature, typed when typed signatures are off',
    type: FieldType.SIGNATURE,
    meta: { type: 'signature' },
    values: both('Sam Rivera'),
    expect: 'refused',
    typedSignatureEnabled: false,
  },
];
