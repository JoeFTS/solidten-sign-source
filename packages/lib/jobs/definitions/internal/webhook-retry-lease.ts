import { prisma } from '@documenso/prisma';

/**
 * Solid Ten: the retry sweep leases a failed webhook call (nextAttemptAt moves forward) before it
 * queues the retry. The retry job ends the lease in the same transaction that stores the new
 * attempt. A call whose lease has ended (nextAttemptAt is null) has its retry recorded already.
 */
export const isWebhookRetryStillOwed = async (callId: string) => {
  const call = await prisma.webhookCall.findUnique({
    where: { id: callId },
    select: { nextAttemptAt: true },
  });

  return Boolean(call?.nextAttemptAt);
};

export const endWebhookRetryLease = (callId: string) =>
  prisma.webhookCall.updateMany({
    where: { id: callId },
    data: { nextAttemptAt: null },
  });
