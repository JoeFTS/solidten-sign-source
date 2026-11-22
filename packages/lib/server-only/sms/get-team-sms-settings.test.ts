import { describe, expect, it } from 'vitest';

import { resolveSmsSenderLabel, SMS_DEFAULT_SENDER_LABEL } from './get-team-sms-settings';

describe('resolveSmsSenderLabel (SEC2-M3)', () => {
  it('uses the admin-set team label, then the organisation label', () => {
    expect(resolveSmsSenderLabel({ teamLabel: 'Team', organisationLabel: 'Org', organisationName: 'Acme' })).toBe(
      'Team',
    );
    expect(resolveSmsSenderLabel({ teamLabel: null, organisationLabel: 'Org', organisationName: 'Acme' })).toBe('Org');
  });

  it('falls back to the organisation name, then a fixed name, never the team name', () => {
    expect(resolveSmsSenderLabel({ teamLabel: null, organisationLabel: null, organisationName: 'Acme Ltd' })).toBe(
      'Acme Ltd',
    );
    expect(resolveSmsSenderLabel({ teamLabel: ' ', organisationLabel: '', organisationName: '  ' })).toBe(
      SMS_DEFAULT_SENDER_LABEL,
    );
  });
});
