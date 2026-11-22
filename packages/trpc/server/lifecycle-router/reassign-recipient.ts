import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { getEnvelopeWhereInput } from '@documenso/lib/server-only/envelope/get-envelope-by-id';
import { reassignRecipient } from '@documenso/lib/server-only/recipient-reassign/reassign-recipient';
import { prisma } from '@documenso/prisma';
import { EnvelopeType } from '@prisma/client';

import { authenticatedProcedure } from '../trpc';
import {
  reassignRecipientMeta,
  ZReassignRecipientRequestSchema,
  ZReassignRecipientResponseSchema,
} from './reassign-recipient.types';

export const reassignRecipientRoute = authenticatedProcedure
  .meta(reassignRecipientMeta)
  .input(ZReassignRecipientRequestSchema)
  .output(ZReassignRecipientResponseSchema)
  .mutation(async ({ input, ctx }) => {
    const { envelopeId, recipientId, name, email, reason, phoneNumber } = input;

    ctx.logger.info({
      input: {
        envelopeId,
        recipientId,
      },
    });

    const { envelopeWhereInput } = await getEnvelopeWhereInput({
      id: { type: 'envelopeId', id: envelopeId },
      type: EnvelopeType.DOCUMENT,
      userId: ctx.user.id,
      teamId: ctx.teamId,
    });

    const envelope = await prisma.envelope.findFirst({
      where: envelopeWhereInput,
      select: { id: true },
    });

    if (!envelope) {
      throw new AppError(AppErrorCode.NOT_FOUND, {
        message: 'Document not found',
      });
    }

    return await reassignRecipient({
      actor: {
        type: 'SENDER',
        userId: ctx.user.id,
        envelopeId: envelope.id,
        recipientId,
        metadata: ctx.metadata,
      },
      name,
      email,
      reason,
      phoneNumber,
    });
  });
