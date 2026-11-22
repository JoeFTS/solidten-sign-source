/**
 * A small formula language for calculated number fields.
 *
 *   {{price}} * {{quantity}}
 *   SUM({{a}}, {{b}}, {{c}}) - {{discount}}
 *   ROUND({{net}} * 1.21, 2)
 *
 * Supports + - * /, parentheses, unary minus, decimal numbers, SUM, MIN, MAX and
 * ROUND(x, digits). It is parsed into a tree and walked; nothing is ever passed to
 * `eval` or `new Function`. Division by zero, a missing source and an out of range
 * result all give an empty value (null), never an error.
 */

export const FORMULA_MAX_LENGTH = 500;
export const FORMULA_MAX_TOKENS = 200;
export const FORMULA_MAX_DEPTH = 20;
export const FORMULA_MAX_ROUND_DIGITS = 10;

// Doubles keep 15 significant digits; beyond this whole numbers stop being exact.
export const FORMULA_MAX_ABSOLUTE_VALUE = 1e15;

const FUNCTION_NAMES = ['SUM', 'MIN', 'MAX', 'ROUND'] as const;

type FormulaFunctionName = (typeof FUNCTION_NAMES)[number];

export type FormulaNode =
  | { kind: 'number'; value: number }
  | { kind: 'reference'; key: string }
  | { kind: 'negate'; operand: FormulaNode }
  | { kind: 'binary'; operator: '+' | '-' | '*' | '/'; left: FormulaNode; right: FormulaNode }
  | { kind: 'call'; name: FormulaFunctionName; args: FormulaNode[] };

type Token =
  | { kind: 'number'; value: number; position: number }
  | { kind: 'reference'; key: string; position: number }
  | { kind: 'name'; name: string; position: number }
  | { kind: 'symbol'; symbol: '+' | '-' | '*' | '/' | '(' | ')' | ','; position: number };

export type ParseFormulaResult =
  | { success: true; ast: FormulaNode; references: string[] }
  | { success: false; error: string };

class FormulaSyntaxError extends Error {}

const REFERENCE_REGEX = /^\{\{\s*([A-Za-z][A-Za-z0-9_]{0,63})\s*\}\}/;
const NUMBER_REGEX = /^(?:\d+(?:\.\d+)?|\.\d+)/;
const NAME_REGEX = /^[A-Za-z]+/;
const SYMBOLS = new Set(['+', '-', '*', '/', '(', ')', ',']);

const tokenize = (formula: string): Token[] => {
  const tokens: Token[] = [];

  let position = 0;

  while (position < formula.length) {
    const rest = formula.slice(position);
    const character = rest[0];

    if (/\s/.test(character)) {
      position++;
      continue;
    }

    if (tokens.length >= FORMULA_MAX_TOKENS) {
      throw new FormulaSyntaxError(`The formula is too long (more than ${FORMULA_MAX_TOKENS} parts).`);
    }

    if (character === '{') {
      const reference = REFERENCE_REGEX.exec(rest);

      if (!reference) {
        throw new FormulaSyntaxError(
          `A field reference at position ${position + 1} must look like {{fieldKey}}, with a valid field key.`,
        );
      }

      tokens.push({ kind: 'reference', key: reference[1], position });
      position += reference[0].length;
      continue;
    }

    const number = NUMBER_REGEX.exec(rest);

    if (number) {
      tokens.push({ kind: 'number', value: Number(number[0]), position });
      position += number[0].length;
      continue;
    }

    const name = NAME_REGEX.exec(rest);

    if (name) {
      tokens.push({ kind: 'name', name: name[0].toUpperCase(), position });
      position += name[0].length;
      continue;
    }

    if (SYMBOLS.has(character)) {
      tokens.push({ kind: 'symbol', symbol: character as Extract<Token, { kind: 'symbol' }>['symbol'], position });
      position++;
      continue;
    }

    throw new FormulaSyntaxError(`The character "${character}" at position ${position + 1} is not allowed.`);
  }

  return tokens;
};

/**
 * Recursive descent over:
 *
 *   expression := term (("+" | "-") term)*
 *   term       := unary (("*" | "/") unary)*
 *   unary      := ("-" | "+") unary | primary
 *   primary    := number | reference | NAME "(" expression ("," expression)* ")" | "(" expression ")"
 */
const parseTokens = (tokens: Token[]): FormulaNode => {
  let index = 0;

  const peek = () => tokens[index];

  const isSymbol = (symbol: string) => {
    const token = peek();

    return token?.kind === 'symbol' && token.symbol === symbol;
  };

  const expectSymbol = (symbol: string) => {
    if (!isSymbol(symbol)) {
      const token = peek();

      throw new FormulaSyntaxError(
        token ? `Expected "${symbol}" at position ${token.position + 1}.` : `Expected "${symbol}" at the end.`,
      );
    }

    index++;
  };

  const enter = (depth: number) => {
    if (depth > FORMULA_MAX_DEPTH) {
      throw new FormulaSyntaxError(`The formula is nested too deeply (more than ${FORMULA_MAX_DEPTH} levels).`);
    }
  };

  const parseExpression = (depth: number): FormulaNode => {
    enter(depth);

    let left = parseTerm(depth);

    while (isSymbol('+') || isSymbol('-')) {
      const operator = (tokens[index++] as Extract<Token, { kind: 'symbol' }>).symbol as '+' | '-';

      left = { kind: 'binary', operator, left, right: parseTerm(depth) };
    }

    return left;
  };

  const parseTerm = (depth: number): FormulaNode => {
    let left = parseUnary(depth);

    while (isSymbol('*') || isSymbol('/')) {
      const operator = (tokens[index++] as Extract<Token, { kind: 'symbol' }>).symbol as '*' | '/';

      left = { kind: 'binary', operator, left, right: parseUnary(depth) };
    }

    return left;
  };

  const parseUnary = (depth: number): FormulaNode => {
    if (isSymbol('-')) {
      index++;
      enter(depth + 1);

      return { kind: 'negate', operand: parseUnary(depth + 1) };
    }

    if (isSymbol('+')) {
      index++;
      enter(depth + 1);

      return parseUnary(depth + 1);
    }

    return parsePrimary(depth);
  };

  const parsePrimary = (depth: number): FormulaNode => {
    const token = peek();

    if (!token) {
      throw new FormulaSyntaxError('The formula ends too early.');
    }

    if (token.kind === 'number') {
      index++;

      return { kind: 'number', value: token.value };
    }

    if (token.kind === 'reference') {
      index++;

      return { kind: 'reference', key: token.key };
    }

    if (token.kind === 'name') {
      const name = FUNCTION_NAMES.find((candidate) => candidate === token.name);

      if (!name) {
        throw new FormulaSyntaxError(
          `"${token.name}" at position ${token.position + 1} is not a known function. Use SUM, MIN, MAX or ROUND.`,
        );
      }

      index++;
      expectSymbol('(');

      const args = [parseExpression(depth + 1)];

      while (isSymbol(',')) {
        index++;
        args.push(parseExpression(depth + 1));
      }

      expectSymbol(')');

      if (name === 'ROUND' && args.length > 2) {
        throw new FormulaSyntaxError('ROUND takes a value and an optional number of digits.');
      }

      return { kind: 'call', name, args };
    }

    if (token.symbol === '(') {
      index++;

      const inner = parseExpression(depth + 1);

      expectSymbol(')');

      return inner;
    }

    throw new FormulaSyntaxError(`Unexpected "${token.symbol}" at position ${token.position + 1}.`);
  };

  const ast = parseExpression(0);

  const trailing = peek();

  if (trailing) {
    throw new FormulaSyntaxError(`Unexpected text at position ${trailing.position + 1}.`);
  }

  return ast;
};

const collectReferences = (node: FormulaNode, references: Set<string>) => {
  switch (node.kind) {
    case 'reference':
      references.add(node.key);
      break;
    case 'negate':
      collectReferences(node.operand, references);
      break;
    case 'binary':
      collectReferences(node.left, references);
      collectReferences(node.right, references);
      break;
    case 'call':
      for (const arg of node.args) {
        collectReferences(arg, references);
      }
      break;
    case 'number':
      break;
  }
};

export const parseFormula = (formula: string): ParseFormulaResult => {
  if (formula.length > FORMULA_MAX_LENGTH) {
    return { success: false, error: `The formula is longer than ${FORMULA_MAX_LENGTH} characters.` };
  }

  if (!formula.trim()) {
    return { success: false, error: 'The formula is empty.' };
  }

  try {
    const ast = parseTokens(tokenize(formula));
    const references = new Set<string>();

    collectReferences(ast, references);

    return { success: true, ast, references: [...references] };
  } catch (error) {
    if (error instanceof FormulaSyntaxError) {
      return { success: false, error: error.message };
    }

    throw error;
  }
};

/**
 * Round half away from zero. `toPrecision(15)` first removes binary noise, so
 * 1.005 rounds to 1.01 and not to 1.00.
 */
export const roundHalfAwayFromZero = (value: number, digits: number) => {
  const factor = 10 ** digits;
  const scaled = Number.parseFloat((Math.abs(value) * factor).toPrecision(15));

  return (Math.sign(value) * Math.round(scaled)) / factor;
};

const normalise = (value: number | null): number | null => {
  if (value === null || !Number.isFinite(value) || Math.abs(value) >= FORMULA_MAX_ABSOLUTE_VALUE) {
    return null;
  }

  const cleaned = Number.parseFloat(value.toPrecision(15));

  return Object.is(cleaned, -0) ? 0 : cleaned;
};

export type FormulaEmptyReason = 'missingSource' | 'divisionByZero' | 'outOfRange' | 'invalidRound';

export type FormulaEvaluation = {
  value: number | null;
  /**
   * Why the value is empty, for the hint the signer sees. Missing sources win over the
   * other reasons, because filling them in is what the signer can do.
   */
  reason: FormulaEmptyReason | null;
  missingKeys: string[];
};

/**
 * Evaluate a parsed formula. `resolveReference` returns the number of a source field,
 * or null when it is missing, hidden or empty; any null makes the result null.
 */
export const evaluateFormulaWithReason = (
  node: FormulaNode,
  resolveReference: (key: string) => number | null,
): FormulaEvaluation => {
  const missingKeys = new Set<string>();
  let isDivisionByZero = false;
  let isOutOfRange = false;
  let isInvalidRound = false;

  const checked = (value: number): number | null => {
    const result = normalise(value);

    if (result === null) {
      isOutOfRange = true;
    }

    return result;
  };

  const evaluate = (current: FormulaNode): number | null => {
    switch (current.kind) {
      case 'number':
        return current.value;
      case 'reference': {
        const value = resolveReference(current.key);

        if (value === null) {
          missingKeys.add(current.key);

          return null;
        }

        return checked(value);
      }
      case 'negate': {
        const operand = evaluate(current.operand);

        return operand === null ? null : -operand;
      }
      case 'binary': {
        const left = evaluate(current.left);
        const right = evaluate(current.right);

        if (left === null || right === null) {
          return null;
        }

        switch (current.operator) {
          case '+':
            return checked(left + right);
          case '-':
            return checked(left - right);
          case '*':
            return checked(left * right);
          case '/':
            if (right === 0) {
              isDivisionByZero = true;

              return null;
            }

            return checked(left / right);
        }

        return null;
      }
      case 'call': {
        const values = current.args.map(evaluate);

        if (values.some((value) => value === null)) {
          return null;
        }

        const numbers = values as number[];

        switch (current.name) {
          case 'SUM':
            return checked(numbers.reduce((total, value) => total + value, 0));
          case 'MIN':
            return Math.min(...numbers);
          case 'MAX':
            return Math.max(...numbers);
          case 'ROUND': {
            const digits = numbers[1] ?? 0;

            if (!Number.isInteger(digits) || digits < 0 || digits > FORMULA_MAX_ROUND_DIGITS) {
              isInvalidRound = true;

              return null;
            }

            return checked(roundHalfAwayFromZero(numbers[0], digits));
          }
        }

        return null;
      }
    }
  };

  const raw = evaluate(node);
  const value = raw === null ? null : checked(raw);

  let reason: FormulaEmptyReason | null = null;

  if (value === null) {
    if (missingKeys.size > 0) {
      reason = 'missingSource';
    } else if (isDivisionByZero) {
      reason = 'divisionByZero';
    } else if (isInvalidRound) {
      reason = 'invalidRound';
    } else if (isOutOfRange) {
      reason = 'outOfRange';
    }
  }

  return { value, reason, missingKeys: [...missingKeys] };
};

export const evaluateFormula = (node: FormulaNode, resolveReference: (key: string) => number | null): number | null =>
  evaluateFormulaWithReason(node, resolveReference).value;

const COMMA_DECIMAL_FORMAT = '123.456.789,00';
const SINGLE_GROUP_FORMAT = '123456,789.00';

const groupThousands = (digits: string, separator: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, separator);

/**
 * Write a calculated value as text. Without a number format the value is plain, with up
 * to 10 decimals and no grouping; with a format it has 2 decimals and the format's
 * separators. Built by hand so the server and every browser print the same text.
 */
export const formatCalculatedValue = (value: number | null, numberFormat?: string | null): string => {
  if (value === null) {
    return '';
  }

  if (!numberFormat) {
    const rounded = roundHalfAwayFromZero(value, FORMULA_MAX_ROUND_DIGITS);
    const text = Math.abs(rounded)
      .toFixed(FORMULA_MAX_ROUND_DIGITS)
      .replace(/\.?0+$/, '');

    return rounded < 0 && text !== '0' ? `-${text}` : text;
  }

  const rounded = roundHalfAwayFromZero(value, 2);
  const [whole, fraction] = Math.abs(rounded).toFixed(2).split('.');

  const isCommaDecimal = numberFormat === COMMA_DECIMAL_FORMAT;
  // "123456,789.00" allows one comma only, so its values are written without grouping.
  const groupedWhole = numberFormat === SINGLE_GROUP_FORMAT ? whole : groupThousands(whole, isCommaDecimal ? '.' : ',');
  const text = `${groupedWhole}${isCommaDecimal ? ',' : '.'}${fraction}`;

  return rounded < 0 ? `-${text}` : text;
};
