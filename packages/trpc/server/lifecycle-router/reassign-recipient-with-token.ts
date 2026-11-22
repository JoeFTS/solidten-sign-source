import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { recipientReassignRateLimit } from '@documenso/lib/server-only/recipient-reassign/rate-limits';
import { reassignRecipient } from '@documenso/lib/server-only/recipient-reassign/reassign-recipient';
import { prisma } from '@documenso/prisma';

import { maybeAuthenticatedProcedure } from '../trpc';
import { ZReassignRecipientResponseSchema, ZReassignRecipientWithTokenRequestSchema } from './reassign-recipient.types';

/**
 * NOTE: THIS IS A PUBLIC PROCEDURE. The signing link token authorizes it; a
 * signed-in user is only used when the recipient must sign in to an account.
 */
export const reassignRecipientWithTokenRoute = maybeAuthenticatedProcedure
  .input(ZReassignRecipientWithTokenRequestSchema)
  .output(ZReassignRecipientResponseSchema)
  .mutation(async ({ input, ctx }) => {
    const { token, name, email, reason, phoneNumber } = input;

    const recipient = await prisma.recipient.findFirst({
      where: { token },
      select: { id: true, envelopeId: true },
    });

    if (!recipient) {
      throw new AppError(AppErrorCode.NOT_FOUND, {
        message: 'This signing link is no longer valid.',
      });
    }

    const rateLimitResult = await recipientReassignRateLimit.check({
      ip: ctx.metadata.requestMetadata.ipAddress ?? 'unknown',
      identifier: `${recipient.envelopeId}:${recipient.id}`,
    });

    if (rateLimitResult.isLimited) {
      throw new AppError(AppErrorCode.TOO_MANY_REQUESTS, {
        message: 'Too many attempts. Try again later.',
      });
    }

    ctx.logger.info({
      input: {
        envelopeId: recipient.envelopeId,
        recipientId: recipient.id,
      },
    });

    return await reassignRecipient({
      actor: {
        type: 'SIGNER',
        token,
        userId: ctx.user?.id,
        requestMetadata: ctx.metadata.requestMetadata,
      },
      name,
      email,
      reason,
      phoneNumber,
    });
  });
