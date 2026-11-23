import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { describeFieldForUser, describeFieldForUserAtStart } from './describe-field';

/**
 * Solid Ten Sign (N-3): refusals a signer or sender reads are plain and hold no internal ids
 * ("Field 810 is read only", "Recipient 219 has unsigned fields"). The ids go to the server log.
 *
 * This test reads the source of every server path a signer or sender reaches and fails when an
 * error message names a field, recipient, document or envelope by an interpolated value.
 */
const REPO = path.resolve(__dirname, '../../..');

const SCANNED = [
  'packages/lib/server-only',
  'packages/lib/utils',
  'packages/lib/advanced-fields-validation',
  'packages/lib/jobs',
  'packages/trpc/server',
  'packages/api',
  'packages/auth/server',
  'apps/remix/server',
];

/**
 * Kept on purpose: API-only checks that echo the caller's own reference back to the caller, who
 * has no other name for it. No signer or web-app sender can reach them.
 */
const ALLOWED = [
  'Recipient with ID ${recipient.id} not found in the template.',
  'Field with ID ${prefillField.id} not found in the template',
];

const ID_IN_MESSAGE =
  /\b(Field|field|Recipient|recipient|Document|document|Envelope|envelope item|Envelope item)( with id| with ID)?:? \$\{/;

const listSourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);

    if (name === 'node_modules' || name.startsWith('.')) {
      return [];
    }

    if (statSync(full).isDirectory()) {
      return listSourceFiles(full);
    }

    return /\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) ? [full] : [];
  });

const findIdMessages = () => {
  const offenders: string[] = [];

  for (const root of SCANNED) {
    for (const file of listSourceFiles(path.join(REPO, root))) {
      const source = readFileSync(file, 'utf8');

      for (const match of source.matchAll(/message:\s*`([^`]*)`/g)) {
        const text = match[1];

        if (ID_IN_MESSAGE.test(text) && !ALLOWED.includes(text)) {
          offenders.push(`${path.relative(REPO, file)}: ${text}`);
        }
      }
    }
  }

  return offenders;
};

describe('N-3: user-facing refusals hold no internal ids', () => {
  it('no error message names a field, recipient or document by its id', () => {
    expect(findIdMessages()).toEqual([]);
  });

  it('the scan finds a message like the ones the tester saw', () => {
    // A guard: the scan must catch the old texts.
    for (const old of ['Field ${fieldId} is read only', 'Recipient ${recipient.id} has unsigned fields']) {
      expect(ID_IN_MESSAGE.test(old)).toBe(true);
    }
  });
});

describe('describeFieldForUser', () => {
  it('uses the label first', () => {
    expect(describeFieldForUser({ type: 'TEXT', page: 2, fieldMeta: { label: 'Company' } })).toBe(
      'the "Company" field on page 2',
    );
  });

  it('else the type and page', () => {
    expect(describeFieldForUser({ type: 'SIGNATURE', page: 1, fieldMeta: null })).toBe('the signature field on page 1');
    expect(describeFieldForUserAtStart({ type: 'EMAIL', page: 3 })).toBe('The email field on page 3');
  });

  it('never a number', () => {
    expect(describeFieldForUser(null)).toBe('this field');
    expect(describeFieldForUser({ type: 'TEXT' })).not.toMatch(/\d/);
  });
});
