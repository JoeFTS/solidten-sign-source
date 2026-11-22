import { zSingleLineText } from '@documenso/lib/utils/safe-text';
import { zEmail } from '@documenso/lib/utils/zod';
import { z } from 'zod';

import type { TrpcRouteMeta } from '../trpc';

export const reassignRecipientMeta: TrpcRouteMeta = {
  openapi: {
    method: 'POST',
    path: '/envelope/recipient/reassign',
    summary: 'Reassign recipient',
    description:
      'Hand a pending recipient to another person. The recipient gets a new signing link, their filled fields are cleared and the new person is emailed.',
    tags: ['Envelope Recipients'],
  },
};

// Solid Ten Sign (S-L5): no control characters or bidirectional overrides in what others read.
const ZReassignTargetSchema = z.object({
  name: zSingleLineText(255),
  email: zEmail().max(254),
  reason: zSingleLineText(500).optional(),
  phoneNumber: z
    .string()
    .trim()
    .max(32)
    .optional()
    .describe(
      "The new person's mobile number, when the envelope delivers by text message. Without it the previous number is removed and the new person is emailed.",
    ),
});

export const ZReassignRecipientRequestSchema = ZReassignTargetSchema.extend({
  envelopeId: z.string(),
  recipientId: z.number(),
});

export const ZReassignRecipientWithTokenRequestSchema = ZReassignTargetSchema.extend({
  token: z.string().min(1),
});

export const ZReassignRecipientResponseSchema = z.object({
  recipientId: z.number(),
  name: z.string(),
  email: z.string(),
});

export const ZGetSignerReassignOptionsRequestSchema = z.object({
  token: z.string().min(1),
});

export const ZGetSignerReassignOptionsResponseSchema = z.object({
  canReassign: z.boolean(),
});
