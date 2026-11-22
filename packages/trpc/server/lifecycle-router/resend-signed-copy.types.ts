import { z } from 'zod';

import { ZSuccessResponseSchema } from '../schema';
import type { TrpcRouteMeta } from '../trpc';

export const resendSignedCopyMeta: TrpcRouteMeta = {
  openapi: {
    method: 'POST',
    path: '/envelope/recipient/resend-signed-copy',
    summary: 'Resend signed copy',
    description:
      'Email one recipient of a completed document the signed copy again (for example after it could not be delivered). Limited per recipient per day.',
    tags: ['Envelope Recipients'],
  },
};

export const ZResendSignedCopyRequestSchema = z.object({
  envelopeId: z.string().describe('The ID of the completed envelope.'),
  recipientId: z.number().describe('The recipient who gets the signed copy again.'),
});

export const ZResendSignedCopyResponseSchema = ZSuccessResponseSchema;
