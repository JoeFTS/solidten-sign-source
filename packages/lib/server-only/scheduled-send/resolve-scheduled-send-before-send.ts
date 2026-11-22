import { prisma } from '@documenso/prisma';
import { EnvelopeScheduledSendStatus } from '@prisma/client';

import { AppError } from '../../errors/app-error';
import type { ApiRequestMetadata } from '../../universal/extract-request-metadata';
import { removeScheduledSend } from './unschedule-envelope-send';

/**
 * Called by sendDocument just before it commits the send, so every send path
 * (app, API v1/v2, bulk send) agrees with the scheduler and a document is sent once.
 *
 * - The scheduled-send worker passes its claim; the row must still carry that exact claim.
 * - Any other caller is a manual send: it removes a waiting schedule, and is refused
 *   while the worker holds the row.
 */
export const resolveScheduledSendBeforeSend = async ({
  envelopeId,
  scheduledSendClaim,
  requestMetadata,
}: {
  envelopeId: string;
  scheduledSendClaim?: { id: string; claimedAt: Date };
  requestMetadata?: ApiRequestMetadata;
}) => {
  if (scheduledSendClaim) {
    const row = await prisma.envelopeScheduledSend.findUnique({
      where: { envelopeId },
      select: { id: true, status: true, claimedAt: true },
    });

    if (
      !row ||
      row.id !== scheduledSendClaim.id ||
      row.status !== EnvelopeScheduledSendStatus.SENDING ||
      row.claimedAt?.getTime() !== scheduledSendClaim.claimedAt.getTime()
    ) {
      throw new AppError('SCHEDULED_SEND_CLAIM_LOST', {
        message: 'The scheduled send no longer holds this document.',
        statusCode: 409,
      });
    }

    return;
  }

  await removeScheduledSend({
    envelopeId,
    reason: 'SENT_MANUALLY',
    requestMetadata,
  });
};
