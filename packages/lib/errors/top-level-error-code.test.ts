import { describe, expect, it } from 'vitest';

import { getTopLevelErrorCode } from './top-level-error-code';

describe('top-level error code of a v2 API answer', () => {
  it('names SERVICE_UNAVAILABLE for a busy server (RT4-L2)', () => {
    expect(getTopLevelErrorCode(503, 'SERVER_BUSY')).toBe('SERVICE_UNAVAILABLE');
  });

  it('keeps the 4xx rule (LD-L7)', () => {
    expect(getTopLevelErrorCode(400, 'ENVELOPE_ITEM_LIMIT_EXCEEDED')).toBe('BAD_REQUEST');
    expect(getTopLevelErrorCode(429, 'TOO_MANY_REQUESTS')).toBe('TOO_MANY_REQUESTS');
    expect(getTopLevelErrorCode(404, 'NOT_FOUND')).toBe('NOT_FOUND');
  });

  it('leaves other server errors alone', () => {
    expect(getTopLevelErrorCode(500, 'UNKNOWN_ERROR')).toBe('INTERNAL_SERVER_ERROR');
    expect(getTopLevelErrorCode(500, 'SOMETHING_ELSE')).toBeNull();
  });
});
