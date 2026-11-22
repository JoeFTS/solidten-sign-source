import { findScheduledSends } from '@documenso/lib/server-only/scheduled-send/find-scheduled-sends';

import { authenticatedProcedure } from '../trpc';
import { ZFindScheduledSendsRequestSchema, ZFindScheduledSendsResponseSchema } from './find-scheduled-sends.types';

export const findScheduledSendsRoute = authenticatedProcedure
  .input(ZFindScheduledSendsRequestSchema)
  .output(ZFindScheduledSendsResponseSchema)
  .query(async ({ input, ctx }) => {
    return await findScheduledSends({
      envelopeIds: input.envelopeIds,
      userId: ctx.user.id,
      teamId: ctx.teamId,
    });
  });
