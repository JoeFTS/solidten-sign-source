import { BackgroundJobStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { findUndeliveredCopies } from './completed-email-delivery';

const task = (name: string, status: BackgroundJobStatus, result: unknown = null) => ({ name, status, result });
const plan = (isOwnerCopyIntended: boolean, recipientIds: number[]) =>
  task('completed-email-plan', BackgroundJobStatus.COMPLETED, { isOwnerCopyIntended, recipientIds });

describe('which signed copies were not delivered when the job is given up (F4-M1)', () => {
  it('mail down all along: every planned copy, also those whose send never started', () => {
    expect(
      findUndeliveredCopies([plan(true, [1, 2, 3]), task('send-owner-completed-email', BackgroundJobStatus.PENDING)]),
    ).toEqual({ isOwnerCopyUndelivered: true, recipientIds: [1, 2, 3] });
  });

  it('only the copies not sent: sent ones are not reported', () => {
    expect(
      findUndeliveredCopies([
        plan(true, [1, 2, 3]),
        task('send-owner-completed-email', BackgroundJobStatus.PENDING),
        task('send-completed-email-1', BackgroundJobStatus.COMPLETED),
        task('send-completed-email-2', BackgroundJobStatus.PENDING),
        task('send-completed-email-3', BackgroundJobStatus.COMPLETED),
      ]),
    ).toEqual({ isOwnerCopyUndelivered: true, recipientIds: [2] });
  });

  it('no owner copy planned (the owner is a recipient): not reported', () => {
    expect(findUndeliveredCopies([plan(false, [4])])).toEqual({ isOwnerCopyUndelivered: false, recipientIds: [4] });
  });

  it('a job from before the plan: the copies whose tasks exist and are open', () => {
    expect(
      findUndeliveredCopies([
        task('send-owner-completed-email', BackgroundJobStatus.COMPLETED),
        task('send-completed-email-7', BackgroundJobStatus.PENDING),
      ]),
    ).toEqual({ isOwnerCopyUndelivered: false, recipientIds: [7] });
  });
});
