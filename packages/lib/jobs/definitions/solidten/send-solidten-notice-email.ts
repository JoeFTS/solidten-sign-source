import { z } from 'zod';

import type { JobDefinition } from '../../client/_internal/job';

const SEND_SOLIDTEN_NOTICE_EMAIL_JOB_DEFINITION_ID = 'send.solidten.notice.email';

export const ZSolidTenNoticeEmailPayloadSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('SCHEDULED_SEND_FAILED'),
    envelopeId: z.string(),
    reason: z.string(),
  }),
  z.object({
    kind: z.literal('RECIPIENT_REASSIGNED'),
    envelopeId: z.string(),
    oldEmail: z.string(),
    oldName: z.string(),
    /** Only when the recipient passed the request on themselves (SEC2-M2). */
    newName: z.string().optional(),
    isSelfReassigned: z.boolean(),
  }),
  z.object({
    kind: z.literal('RECIPIENT_SELF_REASSIGNED'),
    envelopeId: z.string(),
    fromEmail: z.string(),
    fromName: z.string(),
    toEmail: z.string(),
    toName: z.string(),
    reason: z.string().nullable(),
  }),
  z.object({
    kind: z.literal('COMMENT_FROM_RECIPIENT'),
    envelopeId: z.string(),
    commentId: z.string(),
  }),
  z.object({
    kind: z.literal('COMMENT_FROM_TEAM'),
    envelopeId: z.string(),
    commentId: z.string(),
    recipientId: z.number(),
  }),
  z.object({
    kind: z.literal('SIGNER_DEADLINE_PASSED'),
    envelopeId: z.string(),
    recipientId: z.number(),
    /** Solid Ten Sign (AUD-C8): the person the notice is for; a handover in between drops it. */
    recipientEmail: z.string().optional(),
  }),
  z.object({
    kind: z.literal('SIGNING_REQUEST_NOT_DELIVERED'),
    envelopeId: z.string(),
    recipientId: z.number(),
  }),
  z.object({
    // Solid Ten: the completion emails failed on every attempt for these recipients (and maybe
    // the owner's own copy).
    kind: z.literal('COMPLETED_DOCUMENT_NOT_DELIVERED'),
    envelopeId: z.string(),
    recipientIds: z.array(z.number()),
    isOwnerCopyUndelivered: z.boolean(),
  }),
  z.object({
    // Solid Ten Sign (S-2): the seal (final PDF) failed on every attempt. To the owner and the
    // server operators; never to signers.
    kind: z.literal('SEAL_FAILED'),
    envelopeId: z.string(),
    isRejected: z.boolean(),
  }),
]);

export type TSendSolidTenNoticeEmailJobDefinition = z.infer<typeof ZSolidTenNoticeEmailPayloadSchema>;

export const SEND_SOLIDTEN_NOTICE_EMAIL_JOB_DEFINITION = {
  id: SEND_SOLIDTEN_NOTICE_EMAIL_JOB_DEFINITION_ID,
  name: 'Send Solid Ten Sign Notice Email',
  version: '1.0.0',
  trigger: {
    name: SEND_SOLIDTEN_NOTICE_EMAIL_JOB_DEFINITION_ID,
    schema: ZSolidTenNoticeEmailPayloadSchema,
  },
  handler: async ({ payload, io }) => {
    const handler = await import('./send-solidten-notice-email.handler');

    await handler.run({ payload, io });
  },
} as const satisfies JobDefinition<
  typeof SEND_SOLIDTEN_NOTICE_EMAIL_JOB_DEFINITION_ID,
  TSendSolidTenNoticeEmailJobDefinition
>;
