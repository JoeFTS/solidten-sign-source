import { FieldType } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { type FieldLogicInput, fieldsContainUnsignedRequiredVisibleField, resolveFieldLogic } from './field-conditions';
import {
  evaluateFormula,
  evaluateFormulaWithReason,
  FORMULA_MAX_DEPTH,
  FORMULA_MAX_LENGTH,
  formatCalculatedValue,
  parseFormula,
} from './field-formula';
import { validateFieldLogic } from './field-logic-validation';

const evaluate = (formula: string, values: Record<string, number | null> = {}) => {
  const parsed = parseFormula(formula);

  if (!parsed.success) {
    throw new Error(parsed.error);
  }

  return evaluateFormula(parsed.ast, (key) => (key in values ? values[key] : null));
};

describe('parseFormula', () => {
  it('lists references and accepts spaces, case-insensitive functions and decimals', () => {
    const parsed = parseFormula('sum({{ a }}, {{b}}, .5) - {{discount}}');

    expect(parsed).toMatchObject({ success: true, references: ['a', 'b', 'discount'] });
  });

  it.each([
    ['{{price}} *', 'ends too early'],
    ['{{price}} {{qty}}', 'Unexpected text'],
    ['({{a}} + 1', 'Expected ")"'],
    ['POW(2, 3)', 'not a known function'],
    ['{{1bad}}', 'must look like {{fieldKey}}'],
    ['alert("x")', 'is not allowed'],
    ['alert(1)', 'not a known function'],
    ['{{a}} ; 1', 'is not allowed'],
    ['ROUND(1, 2, 3)', 'ROUND takes'],
    ['', 'empty'],
  ])('rejects %s', (formula, message) => {
    const parsed = parseFormula(formula);

    expect(parsed.success).toBe(false);
    expect(parsed.success ? '' : parsed.error).toContain(message);
  });

  it('enforces the length and depth limits', () => {
    expect(parseFormula('1+'.repeat(FORMULA_MAX_LENGTH)).success).toBe(false);
    expect(parseFormula(`${'('.repeat(FORMULA_MAX_DEPTH + 1)}1${')'.repeat(FORMULA_MAX_DEPTH + 1)}`)).toMatchObject({
      success: false,
    });
    expect(parseFormula(`${'-'.repeat(FORMULA_MAX_DEPTH + 1)}1`).success).toBe(false);
    expect(parseFormula(`${'('.repeat(FORMULA_MAX_DEPTH - 1)}1${')'.repeat(FORMULA_MAX_DEPTH - 1)}`).success).toBe(
      true,
    );
  });
});

describe('evaluateFormula', () => {
  it('follows operator precedence, parentheses and unary minus', () => {
    expect(evaluate('2 + 3 * 4')).toBe(14);
    expect(evaluate('(2 + 3) * 4')).toBe(20);
    expect(evaluate('-{{a}} - -2', { a: 5 })).toBe(-3);
    expect(evaluate('10 / 4 - 3')).toBe(-0.5);
  });

  it('computes SUM, MIN, MAX and ROUND, rounding half away from zero', () => {
    expect(evaluate('SUM({{a}}, {{b}}, {{c}}) - {{discount}}', { a: 1, b: 2, c: 3, discount: 10 })).toBe(-4);
    expect(evaluate('MIN(3, -1, 2) + MAX(3, -1, 2)')).toBe(2);
    expect(evaluate('ROUND(1.005, 2)')).toBe(1.01);
    expect(evaluate('ROUND(-2.5)')).toBe(-3);
    expect(evaluate('ROUND(2.345, 1.5)')).toBeNull();
  });

  it('gives an empty value for division by zero, missing sources and out of range results', () => {
    expect(evaluate('{{a}} / ({{b}} - 2)', { a: 1, b: 2 })).toBeNull();
    expect(evaluate('{{a}} + 1', {})).toBeNull();
    expect(evaluate('SUM({{a}}, {{b}})', { a: 1, b: null })).toBeNull();
    expect(evaluate('{{a}} * {{a}}', { a: 1e8 })).toBeNull();
    expect(evaluate('0.1 + 0.2')).toBe(0.3);
  });
});

describe('formatCalculatedValue', () => {
  it('writes plain values without exponent and formatted values with the format separators', () => {
    expect(formatCalculatedValue(0.000000000004)).toBe('0');
    expect(formatCalculatedValue(1234567.125)).toBe('1234567.125');
    expect(formatCalculatedValue(-0.00000000004)).toBe('0');
    expect(formatCalculatedValue(-1234567.125, '123,456,789.00')).toBe('-1,234,567.13');
    expect(formatCalculatedValue(1234567.5, '123.456.789,00')).toBe('1.234.567,50');
    expect(formatCalculatedValue(null, '123,456,789.00')).toBe('');
  });
});

let nextId = 1;

const numberField = (meta: Record<string, unknown>, overrides: Partial<FieldLogicInput> = {}): FieldLogicInput => ({
  id: nextId++,
  type: FieldType.NUMBER,
  recipientId: 1,
  envelopeItemId: 'item-1',
  inserted: false,
  customText: '',
  fieldMeta: { type: 'number', ...meta },
  ...overrides,
});

describe('calculated fields in resolveFieldLogic', () => {
  it('reads sources in their own number format and chains calculated fields', () => {
    const price = numberField(
      { fieldKey: 'price', numberFormat: '123.456.789,00' },
      { inserted: true, customText: '1.000,50' },
    );
    const quantity = numberField({ fieldKey: 'qty' }, { inserted: true, customText: '3' });
    const subtotal = numberField({ fieldKey: 'subtotal', formula: '{{price}} * {{qty}}' });
    const total = numberField({ formula: 'ROUND({{subtotal}} * 1.21, 2)', numberFormat: '123,456,789.00' });

    const states = resolveFieldLogic([total, subtotal, price, quantity]);

    expect(states.get(subtotal.id)?.calculatedValue).toBe('3001.5');
    expect(states.get(total.id)?.calculatedValue).toBe('3,631.82');
  });

  it('treats hidden or other-recipient sources as missing and clears a hidden calculated field', () => {
    const toggle = {
      ...numberField({ fieldKey: 'toggle' }),
      type: FieldType.TEXT,
      fieldMeta: { type: 'text', fieldKey: 'toggle' },
    };
    const amount = numberField(
      { fieldKey: 'amount', condition: { fieldKey: 'toggle', operator: 'notEmpty' } },
      { inserted: true, customText: '5' },
    );
    const theirs = numberField({ fieldKey: 'theirs' }, { recipientId: 2, inserted: true, customText: '7' });
    const usesHidden = numberField({ formula: '{{amount}} + 1' });
    const usesTheirs = numberField({ formula: '{{theirs}} + 1' });
    const hiddenCalculated = numberField({
      formula: '1 + 1',
      condition: { fieldKey: 'toggle', operator: 'notEmpty' },
    });

    const states = resolveFieldLogic([toggle, amount, theirs, usesHidden, usesTheirs, hiddenCalculated]);

    expect(states.get(usesHidden.id)?.calculatedValue).toBe('');
    expect(states.get(usesTheirs.id)?.calculatedValue).toBe('');
    expect(states.get(hiddenCalculated.id)).toMatchObject({ isHidden: true, calculatedValue: '' });
  });

  it('does not loop on a formula cycle and never counts a calculated field as required', () => {
    const a = numberField({ fieldKey: 'a', formula: '{{b}} + 1', required: true });
    const b = numberField({ fieldKey: 'b', formula: '{{a}} + 1' });

    const states = resolveFieldLogic([a, b]);

    expect(states.get(a.id)?.calculatedValue).toBe('');
    expect(states.get(b.id)?.calculatedValue).toBe('');

    const calculatedRequired = numberField({ formula: '1 + 1', required: true });

    expect(
      fieldsContainUnsignedRequiredVisibleField([calculatedRequired] as Parameters<
        typeof fieldsContainUnsignedRequiredVisibleField
      >[0]),
    ).toBe(false);
  });

  it('rejects bad formulas at save time', () => {
    const price = numberField({ fieldKey: 'price' });
    const note = {
      ...numberField({}),
      type: FieldType.TEXT,
      fieldMeta: { type: 'text', fieldKey: 'note', formula: '1' },
    };
    const theirs = numberField({ fieldKey: 'theirs' }, { recipientId: 2 });
    const otherDocument = numberField({ fieldKey: 'elsewhere' }, { envelopeItemId: 'item-2' });

    const syntax = numberField({ formula: '{{price}} *' });
    const usesText = numberField({ formula: '{{note}} + 1' });
    const usesTheirs = numberField({ formula: '{{theirs}} + 1' });
    const usesOtherDocument = numberField({ formula: '{{elsewhere}} + 1' });
    const self = numberField({ fieldKey: 'self', formula: '{{self}} + 1' });
    const loopA = numberField({ fieldKey: 'loopA', formula: '{{loopB}}' });
    const loopB = numberField({ fieldKey: 'loopB', formula: '{{loopA}}' });
    const dangling = numberField({ formula: '{{gone}} + 1' });

    const fields = [
      price,
      note,
      theirs,
      otherDocument,
      syntax,
      usesText,
      usesTheirs,
      usesOtherDocument,
      self,
      loopA,
      loopB,
      dangling,
    ];

    const failingIds = new Set(validateFieldLogic(fields).map((error) => error.fieldId));

    expect([...failingIds].sort((left, right) => left - right)).toEqual(
      [note.id, syntax.id, usesText.id, usesTheirs.id, usesOtherDocument.id, self.id, loopA.id, loopB.id].sort(
        (left, right) => left - right,
      ),
    );

    expect(validateFieldLogic(fields, { strict: true }).some((error) => error.fieldId === dangling.id)).toBe(true);
  });
});

describe('why a calculated field is empty', () => {
  it('names the empty sources, division by zero and out of range', () => {
    const reasonOf = (formula: string, values: Record<string, number | null>) => {
      const parsed = parseFormula(formula);

      if (!parsed.success) {
        throw new Error(parsed.error);
      }

      const { reason, missingKeys } = evaluateFormulaWithReason(parsed.ast, (key) => values[key] ?? null);

      return { reason, missingKeys };
    };

    expect(reasonOf('{{a}} * {{b}} + {{c}}', { a: 2 })).toEqual({ reason: 'missingSource', missingKeys: ['b', 'c'] });
    expect(reasonOf('{{a}} / {{b}}', { a: 2, b: 0 })).toEqual({ reason: 'divisionByZero', missingKeys: [] });
    expect(reasonOf('{{a}} * {{a}}', { a: 1e8 })).toEqual({ reason: 'outOfRange', missingKeys: [] });
    expect(reasonOf('{{a}} + 1', { a: 1 })).toEqual({ reason: null, missingKeys: [] });
  });

  it('counts empty sources as 0 only when the sender asked for it', () => {
    const a = numberField({ fieldKey: 'a' }, { inserted: true, customText: '5' });
    const b = numberField({ fieldKey: 'b' });
    const strict = numberField({ formula: '{{a}} + {{b}}' });
    const lenient = numberField({ formula: '{{a}} + {{b}}', formulaEmptySourcesAsZero: true });

    const states = resolveFieldLogic([a, b, strict, lenient]);

    expect(states.get(strict.id)).toMatchObject({
      calculatedValue: '',
      calculatedEmptyReason: 'missingSource',
      missingSourceKeys: ['b'],
    });
    expect(states.get(lenient.id)).toMatchObject({ calculatedValue: '5', calculatedEmptyReason: null });
  });
});
