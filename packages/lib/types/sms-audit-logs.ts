import { z } from 'zod';

export const ZSmsPurposeSchema = z.enum(['SIGNING_REQUEST', 'REMINDER', 'RESEND']);

export type TSmsPurpose = z.infer<typeof ZSmsPurposeSchema>;

export const ZSmsFailureReasonSchema = z.enum([
  'NO_PHONE',
  'OPTED_OUT',
  'RATE_LIMITED',
  'MESSAGE_TOO_LONG',
  'INVALID_NUMBER',
  'PROVIDER_ERROR',
  'TIMEOUT',
]);

export type TSmsFailureReason = z.infer<typeof ZSmsFailureReasonSchema>;

const ZSmsRecipientDataSchema = z.object({
  recipientEmail: z.string(),
  recipientName: z.string(),
  recipientId: z.number(),
  recipientRole: z.string(),
  // Only the last four digits are kept, e.g. "*******1234". The full number never enters the audit log.
  phoneNumberMasked: z.string().nullable(),
  purpose: ZSmsPurposeSchema,
});

/**
 * Event: A signing link was delivered to the provider as a text message.
 */
export const ZDocumentAuditLogEventSmsSentSchema = z.object({
  type: z.literal('SMS_SENT'),
  data: ZSmsRecipientDataSchema.extend({
    provider: z.string(),
    providerMessageId: z.string().nullable(),
    segments: z.number(),
  }),
});

/**
 * Event: A text message with the signing link could not be sent.
 */
export const ZDocumentAuditLogEventSmsFailedSchema = z.object({
  type: z.literal('SMS_FAILED'),
  data: ZSmsRecipientDataSchema.extend({
    reason: ZSmsFailureReasonSchema,
    providerErrorCode: z.string().nullable(),
  }),
});
