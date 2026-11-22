import { z } from 'zod';

import { ZSuccessResponseSchema } from '../schema';
import type { TrpcRouteMeta } from '../trpc';

export const unscheduleSendMeta: TrpcRouteMeta = {
  openapi: {
    method: 'POST',
    path: '/envelope/unschedule-send',
    summary: 'Remove scheduled envelope send',
    description: 'Remove the scheduled send of a draft envelope. The envelope stays a draft.',
    tags: ['Envelope'],
  },
};

export const ZUnscheduleSendRequestSchema = z.object({
  envelopeId: z.string().describe('The ID of the scheduled draft envelope.'),
});

export const ZUnscheduleSendResponseSchema = ZSuccessResponseSchema;
