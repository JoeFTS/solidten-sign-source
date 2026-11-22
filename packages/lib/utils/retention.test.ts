import { DocumentDataType, DocumentStatus, EnvelopeType } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import {
  isEnvelopeRetentionEligible,
  parseRetentionSettings,
  planStoredObjectDeletion,
  resolveRetentionSettings,
  type TRetentionSettings,
} from './retention';

const now = new Date('2026-06-30T12:00:00.000Z');
const day = 24 * 60 * 60 * 1000;

const rule: TRetentionSettings = {
  enabled: true,
  action: 'PURGE',
  days: 30,
  includeRejected: false,
  includeCancelled: false,
};

const completed = (
  daysAgo: number,
  overrides: Partial<Parameters<typeof isEnvelopeRetentionEligible>[0]['envelope']> = {},
) => ({
  type: EnvelopeType.DOCUMENT,
  status: DocumentStatus.COMPLETED,
  completedAt: new Date(now.getTime() - daysAgo * day),
  deletedAt: null,
  ...overrides,
});

describe('isEnvelopeRetentionEligible', () => {
  it('includes a document finished exactly N days ago and excludes one a millisecond younger', () => {
    expect(isEnvelopeRetentionEligible({ envelope: completed(30), settings: rule, now })).toBe(true);

    expect(
      isEnvelopeRetentionEligible({
        envelope: completed(30, { completedAt: new Date(now.getTime() - 30 * day + 1) }),
        settings: rule,
        now,
      }),
    ).toBe(false);
  });

  it('never touches drafts, pending documents or templates', () => {
    for (const status of [DocumentStatus.DRAFT, DocumentStatus.PENDING]) {
      expect(isEnvelopeRetentionEligible({ envelope: completed(400, { status }), settings: rule, now })).toBe(false);
    }

    expect(
      isEnvelopeRetentionEligible({ envelope: completed(400, { type: EnvelopeType.TEMPLATE }), settings: rule, now }),
    ).toBe(false);
  });

  it('includes rejected and cancelled documents only when the rule says so', () => {
    const rejected = completed(40, { status: DocumentStatus.REJECTED });
    const cancelled = completed(40, { status: DocumentStatus.CANCELLED });

    expect(isEnvelopeRetentionEligible({ envelope: rejected, settings: rule, now })).toBe(false);
    expect(isEnvelopeRetentionEligible({ envelope: cancelled, settings: rule, now })).toBe(false);

    const wider = { ...rule, includeRejected: true, includeCancelled: true };

    expect(isEnvelopeRetentionEligible({ envelope: rejected, settings: wider, now })).toBe(true);
    expect(isEnvelopeRetentionEligible({ envelope: cancelled, settings: wider, now })).toBe(true);
  });

  it('is off when the rule is missing or disabled, and when the finish date is missing', () => {
    expect(isEnvelopeRetentionEligible({ envelope: completed(400), settings: null, now })).toBe(false);
    expect(isEnvelopeRetentionEligible({ envelope: completed(400), settings: { ...rule, enabled: false }, now })).toBe(
      false,
    );
    expect(isEnvelopeRetentionEligible({ envelope: completed(400, { completedAt: null }), settings: rule, now })).toBe(
      false,
    );
  });

  it('skips already deleted documents for soft delete but still purges them', () => {
    const deleted = completed(40, { deletedAt: new Date(now.getTime() - day) });

    expect(isEnvelopeRetentionEligible({ envelope: deleted, settings: { ...rule, action: 'SOFT_DELETE' }, now })).toBe(
      false,
    );
    expect(isEnvelopeRetentionEligible({ envelope: deleted, settings: rule, now })).toBe(true);
  });
});

describe('resolveRetentionSettings', () => {
  it('uses the team override, including an override that turns retention off', () => {
    expect(resolveRetentionSettings({ organisationValue: rule, teamValue: null })).toEqual(rule);
    expect(resolveRetentionSettings({ organisationValue: rule, teamValue: { ...rule, enabled: false } })).toBeNull();
    expect(resolveRetentionSettings({ organisationValue: null, teamValue: { ...rule, days: 7 } })?.days).toBe(7);
  });

  it('treats malformed stored values as off', () => {
    expect(parseRetentionSettings({ enabled: true, action: 'PURGE', days: 0 })).toBeNull();
    expect(parseRetentionSettings('yes')).toBeNull();
    expect(resolveRetentionSettings({ organisationValue: { enabled: true }, teamValue: null })).toBeNull();
  });
});

describe('planStoredObjectDeletion', () => {
  it('deletes own objects and keeps objects another row still uses', () => {
    const plan = planStoredObjectDeletion({
      ownRows: [
        { type: DocumentDataType.S3_PATH, data: 'sealed.pdf', initialData: 'template.pdf' },
        { type: DocumentDataType.S3_PATH, data: 'other.pdf', initialData: 'other.pdf' },
      ],
      valuesUsedElsewhere: new Set(['template.pdf']),
    });

    expect(plan.keysToDelete.sort()).toEqual(['other.pdf', 'sealed.pdf']);
    expect(plan.keysKept).toEqual(['template.pdf']);
  });

  it('never returns inline database values as objects', () => {
    const plan = planStoredObjectDeletion({
      ownRows: [{ type: DocumentDataType.BYTES_64, data: 'JVBERi0x', initialData: 'JVBERi0x' }],
      valuesUsedElsewhere: new Set(),
    });

    expect(plan.keysToDelete).toEqual([]);
  });
});
