import { describe, expect, it } from 'vitest';

import { getEncryptionKeyProblem } from './crypto-key-check';

describe('getEncryptionKeyProblem', () => {
  it('refuses a missing, sample or repeated key', () => {
    expect(getEncryptionKeyProblem(undefined, 'b3c1f0e2a9d84c7e')).not.toBeNull();
    expect(getEncryptionKeyProblem('a7d2e9c4b1f04e8a', '')).not.toBeNull();
    expect(getEncryptionKeyProblem('CAFEBABE', 'b3c1f0e2a9d84c7e')).not.toBeNull();
    expect(getEncryptionKeyProblem('a7d2e9c4b1f04e8a', 'DEADBEEF')).not.toBeNull();
    expect(getEncryptionKeyProblem('a7d2e9c4b1f04e8a', 'a7d2e9c4b1f04e8a')).not.toBeNull();
  });

  it('accepts two different keys of your own', () => {
    expect(getEncryptionKeyProblem('a7d2e9c4b1f04e8a', 'b3c1f0e2a9d84c7e')).toBeNull();
  });
});
