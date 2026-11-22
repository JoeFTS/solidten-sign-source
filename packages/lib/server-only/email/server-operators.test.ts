import { describe, expect, it } from 'vitest';

import { isServiceAccountEmail, withoutServiceAccounts } from './deliverable-recipients';
import { parseOperatorEmails } from './server-operators';

describe('parseOperatorEmails', () => {
  it('reads a comma list of addresses and drops anything else', () => {
    expect(parseOperatorEmails(' Ops@Example.com, , not-an-email,admin@example.org ')).toEqual([
      'ops@example.com',
      'admin@example.org',
    ]);
    expect(parseOperatorEmails(undefined)).toEqual([]);
  });
});

describe('service accounts', () => {
  const serviceAccounts = new Set(['serviceaccount@localhost', 'deleted-account@localhost']);

  it('recognises the service accounts, case and spaces ignored', () => {
    expect(isServiceAccountEmail(' ServiceAccount@localhost ', serviceAccounts)).toBe(true);
    expect(isServiceAccountEmail('ann@example.com', serviceAccounts)).toBe(false);
  });

  it('drops the documenso.com and the configured service accounts from a recipient list', () => {
    const list = withoutServiceAccounts([
      { address: 'serviceaccount@documenso.com' },
      { address: 'deleted-account@documenso.com' },
      { address: 'ann@example.com' },
    ]);

    expect(list).toEqual([{ address: 'ann@example.com' }]);
  });
});
