import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { readDirectLinkSignatureRefusal } from '../errors/direct-link-signature-error';
import { describeFieldForUser, describeFieldForUserAtStart } from './describe-field';
import { describeSignerForSender } from './describe-signer';

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
  'Invalid envelope ID: ${id}',
  'Envelope item with ID "${mapping.envelopeItemId}" not found in template',
  // Admin-only (server administrators, who work with ids).
  'Subscription claim ${claimId} not found',
  'User with ID ${id} not found',
];

const ID_IN_MESSAGE =
  /\b(Field|field|Recipient|recipient|Document|document|Envelope|envelope item|Envelope item)( with id| with ID)?:? \$\{/;

/**
 * Solid Ten Sign (O-F3): any interpolated id, wherever it stands ("(x@example.com, id: ${r.id})",
 * "${contents.map((content) => content.id).join(', ')}").
 */
const ANY_ID_IN_MESSAGE = /\$\{[^}]*(\.id\b|[a-z]Id\b|\bid\b)[^}]*\}/;

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

        if ((ID_IN_MESSAGE.test(text) || ANY_ID_IN_MESSAGE.test(text)) && !ALLOWED.includes(text)) {
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

    // O-F3: the distribute text and a list of content ids.
    for (const old of [
      'The following recipients are missing required fields: ${r.name} (${r.email}, id: ${r.id})',
      "no image attached: ${contentsMissingImages.map((content) => content.id).join(', ')}.",
    ]) {
      expect(ANY_ID_IN_MESSAGE.test(old)).toBe(true);
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

describe('O-F3: signers in sender messages', () => {
  it('a template placeholder is not shown as "Recipient 1"', () => {
    const text = describeSignerForSender({ name: 'Recipient 1', email: 'recipient.1@documenso.com' });

    expect(text).toBe('A signer with no name or email yet');
    expect(`${text} needs at least one signature field without a condition.`).not.toMatch(/Recipient \d+/);
  });

  it('a named signer keeps the name; the direct link signer is named by role', () => {
    expect(describeSignerForSender({ name: 'Sam Rivera', email: 'sam@example.com' })).toBe('Sam Rivera');
    expect(describeSignerForSender({ name: 'Recipient 2', email: 'sam@example.com' })).toBe('sam@example.com');
    expect(describeSignerForSender({ name: 'Direct link recipient', email: 'direct.link@solidten.io' })).toBe(
      'The direct link signer',
    );
  });

  it('the database refusal (O-F1) becomes a plain message', () => {
    const raw = new Error('Invalid `prisma.field.delete()` invocation: ERROR: ST_DIRECT_LINK_FIXED_SIGNATURE:direct');

    expect(readDirectLinkSignatureRefusal({ cause: raw })).toBe(
      'The direct link signer needs at least one signature field without a condition. This template has a direct link that is on, so visitors could not submit it. Keep one signature field without a condition, or turn the direct link off first.',
    );
    expect(readDirectLinkSignatureRefusal(new Error('ST_DIRECT_LINK_FIXED_SIGNATURE:Recipient 1'))).not.toMatch(
      /Recipient \d+/,
    );
    expect(readDirectLinkSignatureRefusal(new Error('something else'))).toBeNull();
  });
});
