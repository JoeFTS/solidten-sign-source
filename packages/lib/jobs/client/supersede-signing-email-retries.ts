import { prisma } from '@documenso/prisma';
import { BackgroundJobStatus } from '@prisma/client';

/**
 * Solid Ten: the sender resent the signing request by hand and it went out. A signing-email job
 * for this recipient that is waiting for its next attempt (mail outage backoff) would send it a
 * second time, so it is closed. Jobs that are not waiting are left alone (a reassign queues a
 * fresh one on purpose).
 */
export const supersedeWaitingSigningEmailRetries = async (recipientId: number) => {
  const { count } = await prisma.backgroundJob.updateMany({
    where: {
      jobId: 'send.signing.requested.email',
      status: BackgroundJobStatus.PENDING,
      nextRunAt: { not: null },
      payload: { path: ['recipientId'], equals: recipientId },
    },
    data: {
      status: BackgroundJobStatus.COMPLETED,
      completedAt: new Date(),
      nextRunAt: null,
    },
  });

  if (count > 0) {
    console.log(
      `[JOBS]: Closed ${count} waiting signing-email retry job(s) for recipient ${recipientId}: resent by hand`,
    );
  }
};
