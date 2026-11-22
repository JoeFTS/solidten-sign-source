import { describe, expect, it } from 'vitest';

import { NEXT_PUBLIC_WEBAPP_URL } from '../constants/app';
import { normalizeReturnTo } from './is-valid-return-to';

const origin = new URL(NEXT_PUBLIC_WEBAPP_URL()).origin;

describe('normalizeReturnTo', () => {
  it('keeps an ordinary path, query and hash', () => {
    expect(normalizeReturnTo('/inbox?page=2#top')).toBe('/inbox?page=2#top');
    expect(normalizeReturnTo(`${origin}/settings/profile`)).toBe('/settings/profile');
  });

  it('never returns a protocol-relative path that leaves the app', () => {
    for (const returnTo of [
      '/.//evil.example/phish',
      '/..//evil.example/phish',
      '/%2e//evil.example/phish',
      `${origin}//evil.example/landing`,
      '/\\evil.example/phish',
    ]) {
      const result = normalizeReturnTo(returnTo);

      if (result !== undefined) {
        expect(result.startsWith('//'), `${returnTo} -> ${result}`).toBe(false);
        expect(new URL(result, NEXT_PUBLIC_WEBAPP_URL()).origin).toBe(origin);
      }
    }
  });
});
