import { describe, expect, it } from 'vitest';

import { escapeCsvCell, toCsv } from './csv';

const parseCsv = (text: string): string[][] => {
  // Minimal RFC 4180 reader, used only to prove the writer round-trips.
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  const body = text.replace(/^﻿/, '');

  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];

    if (inQuotes) {
      if (char === '"' && body[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\r' && body[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i += 1;
    } else {
      cell += char;
    }
  }

  return rows;
};

describe('escapeCsvCell', () => {
  it('quotes commas, quotes and newlines', () => {
    expect(escapeCsvCell('a,b')).toBe('"a,b"');
    expect(escapeCsvCell('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvCell('line\nbreak')).toBe('"line\nbreak"');
    expect(escapeCsvCell('plain')).toBe('"plain"');
  });

  // S-L3: every text cell is quoted, and a formula after any delimiter is neutralised, so a
  // reader set to ";" or tab cannot split a cell into a formula.
  it.each([
    ['Bob;=1+1', `"Bob;'=1+1"`],
    ['Bob,=1+1', `"Bob,'=1+1"`],
    ['Bob\t+1', `"Bob\t'+1"`],
    ['Bob; @cmd', `"Bob; '@cmd"`],
    ['a;b', '"a;b"'],
  ])('neutralises a formula after a delimiter in %j', (input, expected) => {
    expect(escapeCsvCell(input)).toBe(expected);
  });

  it.each(['=SUM(A1:A2)', '+1+1', '-2+3', '@cmd', '\t=1', '\r=1'])('neutralises formula text %j', (input) => {
    const cell = escapeCsvCell(input);

    expect(cell.replace(/^"/, '').startsWith("'")).toBe(true);
  });

  it('keeps real numbers as numbers, including negatives', () => {
    expect(escapeCsvCell(-2.5)).toBe('-2.5');
    expect(escapeCsvCell(0)).toBe('0');
    expect(escapeCsvCell(Number.NaN)).toBe('');
  });

  it('writes dates as ISO and empty values as empty cells', () => {
    expect(escapeCsvCell(new Date('2026-11-20T10:00:00Z'))).toBe('"2026-11-20T10:00:00.000Z"');
    expect(escapeCsvCell(null)).toBe('');
    expect(escapeCsvCell(undefined)).toBe('');
  });
});

describe('toCsv', () => {
  it('round-trips awkward titles exactly, apart from the formula guard', () => {
    const titles = ['Lease, unit 4', 'He said "sign"', 'Two\nlines', 'Łódź – 契約 😀', '  padded  ', '=HYPERLINK("x")'];

    const csv = toCsv(
      ['Title', 'Count'],
      titles.map((title, index) => [title, index]),
    );

    expect(csv.startsWith('﻿"Title","Count"\r\n')).toBe(true);

    const parsed = parseCsv(csv);

    expect(parsed).toHaveLength(titles.length + 1);
    expect(parsed.slice(1).map((row) => row[0])).toEqual([...titles.slice(0, -1), `'=HYPERLINK("x")`]);
    expect(parsed.slice(1).map((row) => row[1])).toEqual(titles.map((_, index) => String(index)));
  });

  it('handles 10,000 rows', () => {
    const rows = Array.from({ length: 10_000 }, (_, index) => [`Doc ${index}, "copy"`, index]);
    const parsed = parseCsv(toCsv(['Title', 'N'], rows));

    expect(parsed).toHaveLength(10_001);
    expect(parsed[10_000]).toEqual(['Doc 9999, "copy"', '9999']);
  });
});
