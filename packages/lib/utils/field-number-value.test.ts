import { describe, expect, it } from 'vitest';

import { validateNumberField } from '../advanced-fields-validation/validate-number';
import { applyDirectTemplateFieldLogic } from './direct-template-field-logic';
import { formatCalculatedValue } from './field-formula';
import { checkNumberInput, NUMBER_FORMATS, parseFieldNumberValue } from './field-number-value';
import { findNumberFieldMetaProblem } from './number-field-meta-check';

// [format, input, expected number or null for refused]
const CASES: [string | null, string, number | null][] = [
  [null, '1234.5', 1234.5],
  [null, '1,234.5', 1234.5],
  [null, '1,234,567', 1234567],
  [null, '1,5', null],
  [null, '12,34', null],
  [null, '1.2.3', null],
  [null, '1,234,56', null],

  ['123,456,789.00', '1,234.5', 1234.5],
  ['123,456,789.00', '1234.5', 1234.5],
  ['123,456,789.00', '1,234,567.89', 1234567.89],
  ['123,456,789.00', '1234,5', null],
  ['123,456,789.00', '1.234,5', null],
  ['123,456,789.00', '1,23', null],
  ['123,456,789.00', '1.234', null],
  ['123,456,789.00', '12.345', null],

  ['123.456.789,00', '1.234,5', 1234.5],
  ['123.456.789,00', '1234,5', 1234.5],
  ['123.456.789,00', '1.234.567,89', 1234567.89],
  ['123.456.789,00', '1,234.5', null],
  ['123.456.789,00', '1.23', null],
  ['123.456.789,00', '1,234', null],

  ['123456,789.00', '1234567,890.5', 1234567890.5],
  ['123456,789.00', '1234,567', 1234567],
  ['123456,789.00', '1234.5', 1234.5],
  ['123456,789.00', '1234,5', null],
  ['123456,789.00', '1234,56', null],
  ['123456,789.00', '1,234,567', null],
  ['123456,789.00', '12345.567', null],
  ['123456,789.00', '12.50', 12.5],
  ['123456,789.00', '0.5', 0.5],
  ['123456,789.00', '2469134.00', 2469134],
];

const FORMATS = [null, ...NUMBER_FORMATS];

/**
 * Every entry point that accepts a typed number, with the same expectation for each case,
 * so two grammars can never disagree again.
 */
const ENTRY_POINTS: [string, (format: string | null, input: string) => boolean][] = [
  ['parseFieldNumberValue (formulas, conditions)', (format, input) => parseFieldNumberValue(input, format) !== null],
  ['checkNumberInput (v2 signing dialog)', (format, input) => checkNumberInput(input, format) === null],
  [
    'validateNumberField on the signing page (sign route, v1 dialog, form submit)',
    (format, input) => validateNumberField(input, { type: 'number', numberFormat: format }, true).length === 0,
  ],
  [
    'validateNumberField for a sender (editor defaults)',
    (format, input) => validateNumberField(input, { type: 'number', numberFormat: format }).length === 0,
  ],
  [
    'findNumberFieldMetaProblem (template prefill, API and editor saves)',
    (format, input) =>
      findNumberFieldMetaProblem({
        type: 'NUMBER',
        fieldMeta: { type: 'number', numberFormat: format, value: input },
      }) === null,
  ],
];

describe.each(ENTRY_POINTS)('%s', (_name, accepts) => {
  it.each(CASES)('format %s, input %s', (format, input, expected) => {
    expect(accepts(format, input)).toBe(expected !== null);
  });
});

describe('parseFieldNumberValue', () => {
  it.each(CASES)('format %s reads %s as %s', (format, input, expected) => {
    expect(parseFieldNumberValue(input, format)).toBe(expected);
  });

  it('reads back every calculated value, including negatives, in its own format', () => {
    for (const format of FORMATS) {
      for (const value of [-1234567.5, 0.5, 12.5, 2469134]) {
        const text = formatCalculatedValue(value, format);

        expect(parseFieldNumberValue(text, format), `${format}: ${text}`).toBe(value);
      }
    }
  });
});

describe('signer and sender input', () => {
  it('refuses negative input in every format, at every input entry point', () => {
    for (const format of FORMATS) {
      expect(checkNumberInput('-5', format)).toBe('negative');
      expect(validateNumberField('-5', { type: 'number', numberFormat: format }, true)).not.toEqual([]);
      expect(
        findNumberFieldMetaProblem({
          type: 'NUMBER',
          fieldMeta: { type: 'number', numberFormat: format, value: '-5' },
        }),
      ).not.toBeNull();
    }
  });

  it('refuses an unknown number format', () => {
    expect(checkNumberInput('5', 'foo')).toBe('unknownFormat');
    expect(
      findNumberFieldMetaProblem({ type: 'NUMBER', fieldMeta: { type: 'number', numberFormat: 'foo' } }),
    ).toContain('unknown number format "foo"');
  });
});

describe('a form submission carrying a calculated value', () => {
  it.each(FORMATS)('accepts the server value back in format %s, and refuses a different number', (format) => {
    const fields = [
      {
        id: 1,
        type: 'NUMBER' as const,
        recipientId: 1,
        envelopeItemId: 'item',
        customText: '',
        fieldMeta: { type: 'number', fieldKey: 'hours', numberFormat: format },
      },
      {
        id: 2,
        type: 'NUMBER' as const,
        recipientId: 1,
        envelopeItemId: 'item',
        customText: '',
        fieldMeta: { type: 'number', formula: '{{hours}} * 2000.5', numberFormat: format },
      },
    ];

    const serverValue = formatCalculatedValue(1234 * 2000.5, format);
    const submit = (total: string) =>
      applyDirectTemplateFieldLogic({
        fields,
        signedFieldValues: [
          { fieldId: 1, value: '1234' },
          { fieldId: 2, value: total },
        ],
        readOnlyValues: new Map(),
      }).success;

    expect(submit(serverValue)).toBe(true);
    // The same number written without the format's grouping and decimals is the same value.
    expect(submit(String(1234 * 2000.5))).toBe(true);
    expect(submit(formatCalculatedValue(1234 * 2000.5 + 1, format))).toBe(false);
  });
});
