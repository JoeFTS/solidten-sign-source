import { resendCompletedCopy } from '@documenso/lib/server-only/document/resend-completed-copy';

import { ZGenericSuccessResponse } from '../schema';
import { authenticatedProcedure } from '../trpc';
import {
  resendSignedCopyMeta,
  ZResendSignedCopyRequestSchema,
  ZResendSignedCopyResponseSchema,
} from './resend-signed-copy.types';

/** Solid Ten Sign: "Resend signed copy" on a recipient of a completed document. */
export const resendSignedCopyRoute = authenticatedProcedure
  .meta(resendSignedCopyMeta)
  .input(ZResendSignedCopyRequestSchema)
  .output(ZResendSignedCopyResponseSchema)
  .mutation(async ({ input, ctx }) => {
    const { envelopeId, recipientId } = input;

    ctx.logger.info({
      input: {
        envelopeId,
        recipientId,
      },
    });

    await resendCompletedCopy({
      envelopeId,
      recipientId,
      userId: ctx.user.id,
      teamId: ctx.teamId,
      requestMetadata: ctx.metadata,
    });

    return ZGenericSuccessResponse;
  });
