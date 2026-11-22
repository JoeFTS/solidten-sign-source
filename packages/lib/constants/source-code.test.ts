import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_SOURCE_CODE_URL, NEXT_PUBLIC_ST_SOURCE_URL, resolveSourceCodeUrl } from './source-code';

describe('source code URL (AGPL link)', () => {
  const previous = process.env.NEXT_PUBLIC_ST_SOURCE_URL;

  afterEach(() => {
    process.env.NEXT_PUBLIC_ST_SOURCE_URL = previous;
  });

  it('defaults when unset or empty', () => {
    expect(resolveSourceCodeUrl(undefined)).toBe(DEFAULT_SOURCE_CODE_URL);
    expect(resolveSourceCodeUrl(null)).toBe(DEFAULT_SOURCE_CODE_URL);
    expect(resolveSourceCodeUrl('   ')).toBe(DEFAULT_SOURCE_CODE_URL);
    expect(DEFAULT_SOURCE_CODE_URL).toBe('https://github.com/JoeFTS/solidten-sign-source');
  });

  it('takes an http or https URL', () => {
    expect(resolveSourceCodeUrl('https://git.example.com/sign')).toBe('https://git.example.com/sign');
    expect(resolveSourceCodeUrl(' http://example.com/src ')).toBe('http://example.com/src');
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,hi',
    'ftp://example.com/src',
    'mailto:a@example.com',
    'not a url',
    '/relative',
  ])('falls back to the default for %s', (value) => {
    expect(resolveSourceCodeUrl(value)).toBe(DEFAULT_SOURCE_CODE_URL);
  });

  it('reads NEXT_PUBLIC_ST_SOURCE_URL', () => {
    process.env.NEXT_PUBLIC_ST_SOURCE_URL = 'https://code.example.org/solidten';
    expect(NEXT_PUBLIC_ST_SOURCE_URL()).toBe('https://code.example.org/solidten');

    process.env.NEXT_PUBLIC_ST_SOURCE_URL = 'javascript:alert(1)';
    expect(NEXT_PUBLIC_ST_SOURCE_URL()).toBe(DEFAULT_SOURCE_CODE_URL);
  });
});
