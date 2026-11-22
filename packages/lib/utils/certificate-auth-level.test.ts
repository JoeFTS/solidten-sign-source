import { describe, expect, it } from 'vitest';

import { getCertificateAuthLevel } from './certificate-auth-level';

describe('getCertificateAuthLevel', () => {
  it('shows the access check when no re-authentication was asked (EXPLICIT_NONE)', () => {
    expect(getCertificateAuthLevel({ actionAuth: 'EXPLICIT_NONE', accessAuth: 'ACCOUNT' })).toBe('ACCOUNT');
    expect(getCertificateAuthLevel({ actionAuth: 'EXPLICIT_NONE', accessAuth: 'TWO_FACTOR_AUTH' })).toBe('TWO_FACTOR');
    expect(getCertificateAuthLevel({ actionAuth: 'EXPLICIT_NONE', accessAuth: undefined })).toBe('EMAIL');
  });

  it('prefers a re-authentication at signing', () => {
    expect(getCertificateAuthLevel({ actionAuth: 'PASSKEY', accessAuth: 'ACCOUNT' })).toBe('PASSKEY_REAUTH');
    expect(getCertificateAuthLevel({ actionAuth: 'TWO_FACTOR_AUTH', accessAuth: undefined })).toBe('TWO_FACTOR_REAUTH');
  });

  it('falls back to the access check, then email', () => {
    expect(getCertificateAuthLevel({ actionAuth: undefined, accessAuth: 'ACCOUNT' })).toBe('ACCOUNT');
    expect(getCertificateAuthLevel({ actionAuth: undefined, accessAuth: undefined })).toBe('EMAIL');
  });
});
