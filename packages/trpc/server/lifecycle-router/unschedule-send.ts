import { unscheduleEnvelopeSend } from '@documenso/lib/server-only/scheduled-send/unschedule-envelope-send';

import { ZGenericSuccessResponse } from '../schema';
import { authenticatedProcedure } from '../trpc';
import {
  unscheduleSendMeta,
  ZUnscheduleSendRequestSchema,
  ZUnscheduleSendResponseSchema,
} from './unschedule-send.types';

export const unscheduleSendRoute = authenticatedProcedure
  .meta(unscheduleSendMeta)
  .input(ZUnscheduleSendRequestSchema)
  .output(ZUnscheduleSendResponseSchema)
  .mutation(async ({ input, ctx }) => {
    const { envelopeId } = input;

    ctx.logger.info({
      input: {
        envelopeId,
      },
    });

    await unscheduleEnvelopeSend({
      envelopeId,
      userId: ctx.user.id,
      teamId: ctx.teamId,
      requestMetadata: ctx.metadata,
    });

    return ZGenericSuccessResponse;
  });
