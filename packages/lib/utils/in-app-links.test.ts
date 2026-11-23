import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Solid Ten Sign (K-1): no page of the app, and no shared UI component, points users at the
 * upstream project's sites (documenso.com, docs.documenso.com, documen.so). Our own Help lives at
 * /help. A static check over the source, so every page is covered, also ones a browser test does
 * not reach. Email templates are not scanned: their documenso.com values are preview defaults
 * that real sends always replace.
 */
const repoRoot = path.resolve(__dirname, '../../..');
const SCANNED = ['apps/remix/app', 'apps/remix/server', 'packages/ui'];
const FORBIDDEN = /documenso\.com|documen\.so/i;

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);

    if (name === 'node_modules' || name.startsWith('.')) {
      return [];
    }

    if (statSync(full).isDirectory()) {
      return sourceFiles(full);
    }

    return /\.(tsx?|jsx?|mjs)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });

describe('in-app links (K-1)', () => {
  it('no app page or UI component mentions documenso.com or documen.so', () => {
    const offenders = SCANNED.flatMap((dir) => sourceFiles(path.join(repoRoot, dir)))
      .flatMap((file) =>
        readFileSync(file, 'utf8')
          .split('\n')
          .map((line, index) => ({ file: path.relative(repoRoot, file), line: index + 1, text: line.trim() }))
          .filter(({ text }) => FORBIDDEN.test(text)),
      )
      .map(({ file, line, text }) => `${file}:${line}: ${text}`);

    expect(offenders).toEqual([]);
  });
});
