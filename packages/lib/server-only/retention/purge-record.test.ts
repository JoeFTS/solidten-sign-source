import { describe, expect, it } from 'vitest';

import { buildPurgeRecordData } from './purge-record';

describe('the record a retention purge keeps (G2)', () => {
  const record = buildPurgeRecordData({
    settings: { days: 30 },
    envelope: {
      id: 'envelope_abc',
      documentId: 42,
      completedAt: new Date('2026-01-02T03:04:05.000Z'),
      recipientCount: 3,
    },
    erasedAuditLogCount: 17,
    deletedObjectCount: 2,
    keptSharedObjectCount: 1,
  });

  it('says which document, when it was completed and how many recipients it had', () => {
    expect(record).toMatchObject({
      action: 'PURGE',
      envelopeId: 'envelope_abc',
      documentId: 42,
      completedAt: '2026-01-02T03:04:05.000Z',
      recipientCount: 3,
      erasedAuditLogCount: 17,
      auditLogIds: [],
    });
  });

  it('holds only counts and ids: no title, names, addresses, IPs, user agents or values', () => {
    expect(Object.keys(record).sort()).toEqual(
      [
        'action',
        'auditLogIds',
        'completedAt',
        'days',
        'deletedObjectCount',
        'documentId',
        'envelopeId',
        'erasedAuditLogCount',
        'keptSharedObjectCount',
        'recipientCount',
      ].sort(),
    );

    for (const value of Object.values(record)) {
      expect(typeof value === 'string' ? value : '').not.toMatch(/@/);
    }
  });
});
