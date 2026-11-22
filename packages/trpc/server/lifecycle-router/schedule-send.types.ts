import { z } from 'zod';
import { ZDistributeEnvelopeRequestSchema } from '../envelope-router/distribute-envelope.types';
import type { TrpcRouteMeta } from '../trpc';

export const scheduleSendMeta: TrpcRouteMeta = {
  openapi: {
    method: 'POST',
    path: '/envelope/schedule-send',
    summary: 'Schedule envelope send',
    description:
      'Send a draft envelope later. The time is a wall-clock time in the given IANA timezone. Scheduling again replaces the previous time.',
    tags: ['Envelope'],
  },
};

export const ZScheduleSendRequestSchema = z.object({
  envelopeId: z.string().describe('The ID of the draft envelope to send later.'),
  localDateTime: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
    .describe('The wall-clock time to send at, in the form yyyy-MM-ddTHH:mm.'),
  timezone: z.string().min(1).max(64).describe('The IANA timezone of localDateTime, for example America/New_York.'),
  meta: ZDistributeEnvelopeRequestSchema.shape.meta,
});

export const ZScheduleSendResponseSchema = z.object({
  envelopeId: z.string(),
  scheduledAt: z.date(),
  timezone: z.string(),
});

export type TScheduleSendRequest = z.infer<typeof ZScheduleSendRequestSchema>;
