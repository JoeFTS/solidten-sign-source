import { describe, expect, it } from 'vitest';

import { mapTwilioError } from './twilio';

describe('mapTwilioError', () => {
  it('reads code 21610 as an opt-out that must not be retried', () => {
    expect(mapTwilioError(400, { code: 21610, message: 'Attempt to send to unsubscribed recipient' })).toMatchObject({
      reason: 'OPTED_OUT',
      errorCode: '21610',
      isRetryable: false,
    });
  });

  it('reads invalid-number codes as permanent', () => {
    expect(mapTwilioError(400, { code: 21211, message: 'Invalid To' })).toMatchObject({
      reason: 'INVALID_NUMBER',
      isRetryable: false,
    });
  });

  it('retries 429 and 5xx, but not other 4xx', () => {
    expect(mapTwilioError(429, { code: 20429 }).isRetryable).toBe(true);
    expect(mapTwilioError(503, null)).toMatchObject({
      reason: 'PROVIDER_ERROR',
      errorCode: 'HTTP_503',
      isRetryable: true,
    });
    expect(mapTwilioError(401, { code: 20003, message: 'Authenticate' }).isRetryable).toBe(false);
  });
});
