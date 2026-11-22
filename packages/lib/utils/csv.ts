export type TCsvCell = string | number | boolean | Date | null | undefined;

// A spreadsheet runs a cell that starts with one of these as a formula ("CSV injection").
const FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r'];

// Solid Ten Sign (S-L3): a reader set to another delimiter (";" in many European locales,
// or tab) splits a cell there, so a formula character right after any delimiter starts a
// new cell too.
const FORMULA_AFTER_DELIMITER = /([,;\t])(\s*)([=+\-@])/g;

/**
 * One CSV cell, RFC 4180 quoted, with formula injection neutralised.
 *
 * Every text cell is quoted (S-L3), so no reader splits it at a comma, semicolon or tab.
 * Text that starts with a formula character, or has one right after a comma, semicolon or
 * tab, gets an apostrophe in front of that character, which spreadsheets show as plain
 * text. Numbers and booleans are written bare, so a negative number stays a number.
 */
export const escapeCsvCell = (value: TCsvCell): string => {
  if (value === null || value === undefined) {
    return '';
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : '';
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }

  let text = value instanceof Date ? value.toISOString() : value;

  if (!(value instanceof Date)) {
    if (FORMULA_PREFIXES.some((prefix) => text.startsWith(prefix))) {
      text = `'${text}`;
    }

    text = text.replace(FORMULA_AFTER_DELIMITER, "$1$2'$3");
  }

  return `"${text.replace(/"/g, '""')}"`;
};

/**
 * Build a CSV document. Starts with a UTF-8 byte order mark so Excel reads accents and emoji
 * correctly, and uses CRLF line endings as RFC 4180 asks.
 */
export const toCsv = (headers: string[], rows: TCsvCell[][]): string => {
  const lines = [headers, ...rows].map((row) => row.map((cell) => escapeCsvCell(cell)).join(','));

  return `﻿${lines.join('\r\n')}\r\n`;
};
