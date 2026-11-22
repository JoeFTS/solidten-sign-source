import { describe, expect, it } from 'vitest';

import { createServerBusyError, isTransactionTimeoutError } from './server-busy';

describe('server busy (LD2-A)', () => {
  it('recognises a transaction that ran out of time', () => {
    expect(
      isTransactionTimeoutError({
        code: 'P2028',
        message:
          'Transaction API error: Transaction already closed: A commit cannot be executed on an expired transaction. The timeout for this transaction was 10000 ms, however 18546 ms passed since the start of the transaction.',
      }),
    ).toBe(true);
    expect(isTransactionTimeoutError(new Error('Transaction already closed: ...'))).toBe(true);
    expect(isTransactionTimeoutError({ code: 'P2002', message: 'Unique constraint failed' })).toBe(false);
    expect(isTransactionTimeoutError(null)).toBe(false);
  });

  it('answers 503 with Retry-After and a plain message', () => {
    const error = createServerBusyError(10);

    expect(error.code).toBe('SERVER_BUSY');
    expect(error.statusCode).toBe(503);
    expect(error.headers).toEqual({ 'Retry-After': '10' });
    expect(error.message).toBe('The server is busy, try again.');
  });
});
