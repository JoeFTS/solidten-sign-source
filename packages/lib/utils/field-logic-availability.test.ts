import { describe, expect, it } from 'vitest';

import { getFieldLogicUnavailableReason } from './field-logic-availability';

describe('getFieldLogicUnavailableReason', () => {
  it('allows version 2 envelopes, including templates with a public form, and refuses v1 and TSP', () => {
    expect(getFieldLogicUnavailableReason({ internalVersion: 2, signatureLevel: 'SES' })).toBeNull();
    expect(getFieldLogicUnavailableReason({ internalVersion: 2 })).toBeNull();
    expect(getFieldLogicUnavailableReason({ internalVersion: 1, signatureLevel: 'SES' })).toBe('VERSION_1');
    expect(getFieldLogicUnavailableReason({ internalVersion: 2, signatureLevel: 'QES' })).toBe('TSP');
  });
});
