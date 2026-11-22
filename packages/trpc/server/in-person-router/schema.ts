import { z } from 'zod';

const ZSessionIdSchema = z.string().min(1).max(64);
const ZPinSchema = z.string().max(16);

export const ZStartInPersonSessionRequestSchema = z.object({
  envelopeId: z.string().min(1),
  pin: z.string().regex(/^\d{4,8}$/, 'The PIN must be 4 to 8 digits.'),
  emailCodeRecipientIds: z.number().int().array().max(100).default([]),
});

export const ZStartInPersonSessionResponseSchema = z.object({
  sessionId: z.string(),
});

export const ZInPersonSessionRequestSchema = z.object({
  sessionId: ZSessionIdSchema,
});

export const ZBeginInPersonHandoverRequestSchema = z.object({
  sessionId: ZSessionIdSchema,
  recipientId: z.number().int(),
});

export const ZConfirmInPersonSignerRequestSchema = z.object({
  sessionId: ZSessionIdSchema,
  name: z.string().max(255),
});

export const ZConfirmInPersonSignerResponseSchema = z.object({
  needsEmailCode: z.boolean(),
});

export const ZVerifyInPersonEmailCodeRequestSchema = z.object({
  sessionId: ZSessionIdSchema,
  code: z.string().max(16),
});

export const ZInPersonPinRequestSchema = z.object({
  sessionId: ZSessionIdSchema,
  pin: ZPinSchema,
});

export const ZExitInPersonSessionResponseSchema = z.object({
  documentPath: z.string(),
});

export const ZInPersonEnvelopeRequestSchema = z.object({
  envelopeId: z.string().min(1),
});

export const ZGetInPersonOptionsResponseSchema = z.object({
  isAvailable: z.boolean(),
  unavailableReason: z.string().nullable(),
  signers: z
    .object({
      recipientId: z.number(),
      name: z.string(),
      email: z.string(),
      isTheirTurn: z.boolean(),
      blockMessage: z.string().nullable(),
    })
    .array(),
  activeSessions: z
    .object({
      id: z.string(),
      hostName: z.string(),
      startedAt: z.date(),
    })
    .array(),
});
