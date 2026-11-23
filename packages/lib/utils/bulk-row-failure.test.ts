import { describe, expect, it } from 'vitest';

import { AppError, AppErrorCode } from '../errors/app-error';
import { describeBulkRowFailure } from './bulk-row-failure';

/** The job runner's wrapper (local.ts / bullmq.ts): "Task failed" with the real error as cause. */
const wrapped = (cause: unknown) => new Error('Task failed', { cause });

describe('P-5: a bulk-send row failure carries the plain reason', () => {
  it('unwraps "Task failed" to the refusal', () => {
    const refusal = new AppError(AppErrorCode.INVALID_BODY, {
      message: 'This template uses "Require password", which cannot be used on this server.',
    });

    expect(describeBulkRowFailure(wrapped(refusal))).toBe(
      'This template uses "Require password", which cannot be used on this server.',
    );
  });

  it('the database refusal of a broken direct link', () => {
    expect(describeBulkRowFailure(wrapped(new Error('ERROR: ST_DIRECT_LINK_SIGNER:role')))).toContain(
      'must stay a signer',
    );
  });

  it('a send failure and an unknown error say what to do, with no internals', () => {
    expect(describeBulkRowFailure(wrapped(new AppError('DOCUMENT_SEND_FAILED')))).toBe(
      'The document was created but could not be sent. Open it and send it again.',
    );
    expect(describeBulkRowFailure(wrapped(new Error('Invalid `prisma.envelope.create()` invocation')))).toBe(
      'Something went wrong. Try again.',
    );
    expect(describeBulkRowFailure(wrapped(new Error('x')))).not.toContain('Task failed');
  });
});
