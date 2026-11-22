/**
 * The one number grammar per number format. Every place that reads or checks a number
 * field value uses it: `validateNumberField` (sign route, v1 and v2 signing dialogs, direct
 * template / public form submit, sender prefill and field defaults), the formulas, and the
 * output of calculated values. The editor's format list (`numberFormatValues`) holds only
 * labels; it has no pattern of its own any more.
 *
 * A value must match its field's format exactly: group separators only between groups of
 * three digits, and only the format's decimal separator. Nothing is ever dropped
 * silently, so "1234,5" in a "123456,789.00" field is refused instead of read as 12345.
 */
const NUMBER_FORMAT_GRAMMARS: Record<string, { regex: RegExp; group: string; decimal: string }> = {
  // 1,234,567.89 or 1234567.89
  '123,456,789.00': { regex: /^-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?$/, group: ',', decimal: '.' },
  // 1.234.567,89 or 1234567,89
  '123.456.789,00': { regex: /^-?(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d{1,2})?$/, group: '.', decimal: ',' },
  // 1234567, 1234,567, 1234,567.89 or 12.5: at most one comma, followed by exactly three digits.
  '123456,789.00': { regex: /^-?\d+(?:,\d{3})?(?:\.\d{1,2})?$/, group: ',', decimal: '.' },
};

// Without a format: plain digits with a dot decimal; commas only as thousands groups.
const DEFAULT_GRAMMAR = { regex: /^-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/, group: ',', decimal: '.' };

export const NUMBER_FORMATS = Object.keys(NUMBER_FORMAT_GRAMMARS);

export const isKnownNumberFormat = (numberFormat: string) => numberFormat in NUMBER_FORMAT_GRAMMARS;

const getNumberFormatGrammar = (numberFormat?: string | null) =>
  (numberFormat ? NUMBER_FORMAT_GRAMMARS[numberFormat] : undefined) ?? DEFAULT_GRAMMAR;

/**
 * Parse a number field value with the field's number format. Accepts a leading minus, so
 * negative calculated values parse back.
 *
 * Returns null when the value is empty or does not match the format exactly.
 */
export const parseFieldNumberValue = (value: string | null | undefined, numberFormat?: string | null) => {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  const grammar = getNumberFormatGrammar(numberFormat);

  if (!grammar.regex.test(trimmed)) {
    return null;
  }

  const normalised = trimmed.split(grammar.group).join('').replace(grammar.decimal, '.');
  const parsed = Number(normalised);

  return Number.isFinite(parsed) ? parsed : null;
};

export type NumberInputProblem = 'unknownFormat' | 'format' | 'negative';

/**
 * Check a value typed by a signer or a sender. Negative input is refused in every format;
 * only the server's own calculated values may be negative.
 */
export const checkNumberInput = (value: string, numberFormat?: string | null): NumberInputProblem | null => {
  if (numberFormat && !isKnownNumberFormat(numberFormat)) {
    return 'unknownFormat';
  }

  if (parseFieldNumberValue(value, numberFormat) === null) {
    return 'format';
  }

  if (value.trim().startsWith('-')) {
    return 'negative';
  }

  return null;
};

export const describeNumberInputProblem = (
  value: string,
  numberFormat: string | null | undefined,
  problem: NumberInputProblem,
) => {
  switch (problem) {
    case 'unknownFormat':
      return `Unknown number format "${numberFormat}". Use one of: ${NUMBER_FORMATS.join(', ')}.`;
    case 'negative':
      return `Value ${value} is negative. Only zero and positive numbers can be entered.`;
    case 'format':
      return numberFormat
        ? `Value ${value} does not match the number format ${numberFormat}.`
        : `Value ${value} is not a valid number. Use digits, an optional dot for decimals and commas only between groups of three digits.`;
  }
};
