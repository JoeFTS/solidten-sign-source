import { describe, expect, it } from 'vitest';

import { getCertificateAuthLevel } from './certificate-auth-level';
import { getRecordedAccessAuth } from './certificate-recorded-access';
import { parseDocumentAuditLogData } from './document-audit-logs';

const auditRow = (type: string, data: Record<string, unknown>) =>
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  parseDocumentAuditLogData({
    id: `log-${type}-${String(data.recipientId)}`,
    envelopeId: 'envelope_1',
    createdAt: new Date('2026-11-21T10:00:00Z'),
    type,
    data,
    name: 'Signer',
    email: 'signer@example.com',
    userId: null,
    userAgent: 'test',
    ipAddress: '127.0.0.1',
  } as Parameters<typeof parseDocumentAuditLogData>[0]);

const recipientData = (recipientId: number) => ({
  recipientEmail: `r${recipientId}@example.com`,
  recipientName: `R${recipientId}`,
  recipientId,
  recipientRole: 'SIGNER',
});

describe('getRecordedAccessAuth (AUD-8)', () => {
  it('keeps the recorded access methods on completed and rejected rows', () => {
    const completed = auditRow('DOCUMENT_RECIPIENT_COMPLETED', { ...recipientData(1), actionAuth: [], accessAuth: [] });
    const rejected = auditRow('DOCUMENT_RECIPIENT_REJECTED', {
      ...recipientData(2),
      reason: 'no',
      accessAuth: ['ACCOUNT'],
    });

    expect(getRecordedAccessAuth([completed, rejected], 1)).toEqual([]);
    expect(getRecordedAccessAuth([completed, rejected], 2)).toEqual(['ACCOUNT']);
  });

  it('prints what the recipient passed, not an access setting added before the seal', () => {
    const completed = auditRow('DOCUMENT_RECIPIENT_COMPLETED', { ...recipientData(1), actionAuth: [], accessAuth: [] });
    const liveAtSeal = ['ACCOUNT' as const];

    const accessAuth = (getRecordedAccessAuth([completed], 1) ?? liveAtSeal).at(0);

    expect(getCertificateAuthLevel({ actionAuth: undefined, accessAuth })).toBe(
      getCertificateAuthLevel({ actionAuth: undefined, accessAuth: undefined }),
    );
    expect(getCertificateAuthLevel({ actionAuth: undefined, accessAuth })).not.toBe(
      getCertificateAuthLevel({ actionAuth: undefined, accessAuth: 'ACCOUNT' }),
    );
  });

  it('falls back (undefined) for rows written before the field existed', () => {
    const old = auditRow('DOCUMENT_RECIPIENT_COMPLETED', { ...recipientData(1), actionAuth: [] });

    expect(getRecordedAccessAuth([old], 1)).toBeUndefined();
  });
});
