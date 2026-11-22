import { EnvelopeScheduledSendStatus } from '@prisma/client';
import { z } from 'zod';

export const ZFindScheduledSendsRequestSchema = z.object({
  envelopeIds: z.string().array().max(100),
});

export const ZFindScheduledSendsResponseSchema = z
  .object({
    envelopeId: z.string(),
    scheduledAt: z.date(),
    timezone: z.string(),
    status: z.nativeEnum(EnvelopeScheduledSendStatus),
    lastError: z.string().nullable(),
  })
  .array();
