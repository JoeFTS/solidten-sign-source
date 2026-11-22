import { describe, expect, it } from 'vitest';

import { sanitizeMultiLineText, sanitizeSingleLineText, zSingleLineText } from './safe-text';

describe('sanitizeSingleLineText', () => {
  it('removes the reviewer example: a right-to-left override and a newline', () => {
    expect(sanitizeSingleLineText('Orig‮LIAM\nSigned by CEO')).toBe('OrigLIAM Signed by CEO');
  });

  it.each(['‪', '‫', '‬', '‭', '‮', '⁦', '⁧', '⁨', '⁩', '‎', '‏'])('drops bidirectional control %j', (control) => {
    expect(sanitizeSingleLineText(`a${control}b`)).toBe('ab');
  });

  it('turns control characters into single spaces and trims', () => {
    expect(sanitizeSingleLineText('  Ann\t\r\n\u0000 Lee\u0085 ')).toBe('Ann Lee');
  });

  it.each([
    '\u200B',
    '\u200C',
    '\u200D',
    '\u2060',
    '\uFEFF',
    '\u00AD',
    '\u180E',
    '\u3164',
  ])('drops invisible character %j (SEC2-L2)', (invisible) => {
    expect(sanitizeSingleLineText(`Pat${invisible}Lee`)).toBe('PatLee');
  });

  it('keeps ordinary letters, accents and emoji', () => {
    expect(sanitizeSingleLineText('Łódź – 契約 😀')).toBe('Łódź – 契約 😀');
  });
});

describe('sanitizeMultiLineText', () => {
  it('keeps line breaks and tabs, drops other controls and bidi overrides', () => {
    expect(sanitizeMultiLineText('line one\r\nline\ttwo\u0007‮')).toBe('line one\nline\ttwo');
  });
});

describe('zSingleLineText', () => {
  it('checks the length, then cleans', () => {
    expect(zSingleLineText(10).parse(' A‮B ')).toBe('AB');
    expect(zSingleLineText(3).safeParse('abcd').success).toBe(false);
  });
});
