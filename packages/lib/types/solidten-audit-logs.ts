/////////////////////////////////////////////////////////////////////////////////////////////
//
// Solid Ten Sign audit log events. Stored as JSON, so changes may need migrations.
//
// The literals are written out instead of using DOCUMENT_AUDIT_LOG_TYPE because
// `document-audit-logs.ts` imports this file.
//
/////////////////////////////////////////////////////////////////////////////////////////////
import { z } from 'zod';

export const SOLIDTEN_AUDIT_LOG_TYPES = [
  'DOCUMENT_SEND_SCHEDULED',
  'DOCUMENT_SEND_UNSCHEDULED',
  'DOCUMENT_SCHEDULED_SEND_FAILED',
  'RECIPIENT_REASSIGNED',
  'DOCUMENT_RETENTION_APPLIED',
  'DOCUMENT_PUBLIC_FORM_SUBMITTED',
  'FIELD_FILE_UPLOADED',
  'FIELD_FILE_REPLACED',
  'FIELD_FILE_REMOVED',
  'IN_PERSON_SESSION_STARTED',
  'IN_PERSON_SIGNER_STARTED',
  'IN_PERSON_SESSION_ENDED',
  'COMMENT_CREATED',
  'COMMENT_THREAD_RESOLVED',
  'COMMENT_SETTINGS_UPDATED',
  'FIELD_FILE_DOWNLOADED',
  'EMAIL_NOT_DELIVERED',
  'DOCUMENT_ACCESS_AUTH_2FA_LOCKED',
  'DOCUMENT_SEAL_FAILED',
  'DIRECT_LINK_SUBMISSION_REFUSED',
] as const;

/**
 * The staff user who hosted an in-person signing. Added to the recipient's own
 * completed / rejected entries; the recipient stays the actor of those entries.
 */
export const ZInPersonHostMarkerSchema = z.object({
  sessionId: z.string(),
  hostUserId: z.number(),
  hostName: z.string(),
  hostEmail: z.string(),
  /** Whether the signer proved control of their email with a code before signing. */
  emailCodeVerified: z.boolean(),
});

export type TInPersonHostMarker = z.infer<typeof ZInPersonHostMarkerSchema>;

/**
 * Event: The sender scheduled the document to be sent later.
 */
export const ZDocumentAuditLogEventDocumentSendScheduledSchema = z.object({
  type: z.literal('DOCUMENT_SEND_SCHEDULED'),
  data: z.object({
    scheduledAt: z.string(),
    timezone: z.string(),
    previousScheduledAt: z.string().nullable(),
  }),
});

/**
 * Event: A scheduled send was removed, by the sender or because the document was sent by hand.
 */
export const ZDocumentAuditLogEventDocumentSendUnscheduledSchema = z.object({
  type: z.literal('DOCUMENT_SEND_UNSCHEDULED'),
  data: z.object({
    scheduledAt: z.string(),
    reason: z.enum(['UNSCHEDULED', 'SENT_MANUALLY']),
  }),
});

/**
 * Event: The scheduled send ran and could not send the document.
 */
export const ZDocumentAuditLogEventDocumentScheduledSendFailedSchema = z.object({
  type: z.literal('DOCUMENT_SCHEDULED_SEND_FAILED'),
  data: z.object({
    scheduledAt: z.string(),
    reason: z.string(),
  }),
});

export const ZRecipientHandoverTriggerSchema = z.enum([
  'REASSIGN',
  'EMAIL_CHANGE',
  'PHONE_CHANGE',
  'ADMIN_EDIT',
  'DICTATED_NEXT_SIGNER',
]);

export type TRecipientHandoverTrigger = z.infer<typeof ZRecipientHandoverTriggerSchema>;

/**
 * Event: A signing request was handed to another person (or another phone), with a
 * new link. The person who did it is the audit row's user. `trigger` says which
 * action caused it; entries written before it existed are reassignments. Phone
 * numbers are masked to the last four digits.
 */
export const ZDocumentAuditLogEventRecipientReassignedSchema = z.object({
  type: z.literal('RECIPIENT_REASSIGNED'),
  data: z.object({
    recipientId: z.number(),
    recipientRole: z.string(),
    fromName: z.string(),
    fromEmail: z.string(),
    toName: z.string(),
    toEmail: z.string(),
    reason: z.string().nullable(),
    reassignedBy: z.enum(['SIGNER', 'SENDER', 'ADMIN']),
    clearedFieldIds: z.number().array(),
    trigger: ZRecipientHandoverTriggerSchema.optional(),
    fromPhone: z.string().nullable().optional(),
    toPhone: z.string().nullable().optional(),
  }),
});

/**
 * Event: A retention rule soft-deleted or purged the document. For a purge this
 * is the only entry left: the purge erases the document's other audit rows
 * (purge-record.ts). Records written before that change list the rows they
 * were the last of in `auditLogIds`.
 */
export const ZDocumentAuditLogEventDocumentRetentionAppliedSchema = z.object({
  type: z.literal('DOCUMENT_RETENTION_APPLIED'),
  data: z.object({
    action: z.enum(['SOFT_DELETE', 'PURGE']),
    days: z.number(),
    completedAt: z.string(),
    envelopeId: z.string(),
    documentId: z.number(),
    auditLogIds: z.string().array(),
    // Solid Ten Sign (G2): on a purge, the number of recipients and of audit rows erased.
    recipientCount: z.number().optional(),
    erasedAuditLogCount: z.number().optional(),
    deletedObjectCount: z.number(),
    keptSharedObjectCount: z.number(),
  }),
});

/**
 * Event: The document was created by a submission of a public form. `emailVerified` says
 * whether the submitter proved the address with an emailed code before submitting.
 */
export const ZDocumentAuditLogEventDocumentPublicFormSubmittedSchema = z.object({
  type: z.literal('DOCUMENT_PUBLIC_FORM_SUBMITTED'),
  data: z.object({
    formId: z.string(),
    recipientId: z.number(),
    submitterEmail: z.string(),
    emailVerified: z.boolean(),
  }),
});

const ZFieldFileAuditDataSchema = z.object({
  fieldId: z.string(),
  recipientId: z.number(),
  recipientEmail: z.string(),
  recipientName: z.string(),
  fileId: z.string(),
  fileName: z.string(),
  size: z.number(),
  sha256: z.string(),
});

/**
 * Event: A signer attached a file to an "Attach a file" field.
 */
export const ZDocumentAuditLogEventFieldFileUploadedSchema = z.object({
  type: z.literal('FIELD_FILE_UPLOADED'),
  data: ZFieldFileAuditDataSchema,
});

/**
 * Event: A signer replaced an attached file with a new one.
 */
export const ZDocumentAuditLogEventFieldFileReplacedSchema = z.object({
  type: z.literal('FIELD_FILE_REPLACED'),
  data: ZFieldFileAuditDataSchema.extend({
    previousFileId: z.string(),
    previousFileName: z.string(),
    previousSize: z.number(),
    previousSha256: z.string(),
  }),
});

/**
 * Event: A staff user started hosting signers in person on their device.
 * The host is the audit row's user.
 */
export const ZDocumentAuditLogEventInPersonSessionStartedSchema = z.object({
  type: z.literal('IN_PERSON_SESSION_STARTED'),
  data: z.object({
    sessionId: z.string(),
    hostUserId: z.number(),
    hostName: z.string(),
    hostEmail: z.string(),
    emailCodeRecipientIds: z.number().array(),
  }),
});

/**
 * Event: The host handed the device to a signer, who confirmed their name (and
 * their email code, when required) and opened the document. The signer is the
 * audit row's user; the host is in the data.
 */
export const ZDocumentAuditLogEventInPersonSignerStartedSchema = z.object({
  type: z.literal('IN_PERSON_SIGNER_STARTED'),
  data: ZInPersonHostMarkerSchema.extend({
    recipientId: z.number(),
    recipientName: z.string(),
    recipientEmail: z.string(),
    recipientRole: z.string(),
    confirmedName: z.string(),
  }),
});

/**
 * Event: An attached file was removed, by the signer or because its field was hidden by
 * a condition or cleared by a reassignment.
 */
export const ZDocumentAuditLogEventFieldFileRemovedSchema = z.object({
  type: z.literal('FIELD_FILE_REMOVED'),
  data: ZFieldFileAuditDataSchema.extend({
    reason: z.enum(['SIGNER', 'CONDITION', 'REASSIGNED']),
  }),
});

/**
 * Event: An in-person signing session ended.
 */
export const ZDocumentAuditLogEventInPersonSessionEndedSchema = z.object({
  type: z.literal('IN_PERSON_SESSION_ENDED'),
  data: z.object({
    sessionId: z.string(),
    hostUserId: z.number(),
    hostName: z.string(),
    hostEmail: z.string(),
    reason: z.enum(['EXITED', 'PIN_LOCKOUT', 'EXPIRED', 'REPLACED', 'ENDED_ELSEWHERE']),
    /** Who ended it. Missing on entries written before this field existed (then the host). */
    endedByUserId: z.number().optional(),
    endedByName: z.string().optional(),
    endedByEmail: z.string().optional(),
  }),
});

/**
 * Event: A recipient or a team member wrote a comment. The text is stored in
 * the EnvelopeComment row; this entry references it. `body` is never stored
 * here: the audit-log PDF fills it in from the comment row when it renders.
 */
export const ZDocumentAuditLogEventCommentCreatedSchema = z.object({
  type: z.literal('COMMENT_CREATED'),
  data: z.object({
    commentId: z.string(),
    threadId: z.string(),
    isSharedThread: z.boolean(),
    threadRecipientId: z.number().nullable(),
    authorType: z.enum(['RECIPIENT', 'TEAM']),
    authorRecipientId: z.number().nullable(),
    length: z.number(),
    body: z.string().optional(),
  }),
});

/**
 * Event: A team member marked a comment thread resolved, or opened it again.
 */
export const ZDocumentAuditLogEventCommentThreadResolvedSchema = z.object({
  type: z.literal('COMMENT_THREAD_RESOLVED'),
  data: z.object({
    threadId: z.string(),
    threadRecipientId: z.number().nullable(),
    resolved: z.boolean(),
  }),
});

/**
 * Event: The sender changed the comment settings for this document.
 */
export const ZDocumentAuditLogEventCommentSettingsUpdatedSchema = z.object({
  type: z.literal('COMMENT_SETTINGS_UPDATED'),
  data: z.object({
    enabled: z.boolean(),
    sharedThread: z.boolean(),
  }),
});

/**
 * Event: Someone downloaded a file a signer attached. The audit row's user is the
 * team member or the recipient; `via` says which route was used.
 */
export const ZDocumentAuditLogEventFieldFileDownloadedSchema = z.object({
  type: z.literal('FIELD_FILE_DOWNLOADED'),
  data: ZFieldFileAuditDataSchema.extend({
    via: z.enum(['TEAM', 'RECIPIENT']),
    /** The team member's sign-in (Session.id), or null for a recipient link. */
    authSessionId: z.string().nullable(),
    /** The recipient whose link was used, for a recipient download. */
    downloadedByRecipientId: z.number().nullable(),
  }),
});

/**
 * Event: An email to a recipient could not be delivered after every retry (about five hours):
 * the signing request, or the signed copy when the document completed.
 */
export const ZDocumentAuditLogEventEmailNotDeliveredSchema = z.object({
  type: z.literal('EMAIL_NOT_DELIVERED'),
  data: z.object({
    // Solid Ten Sign (N-6): absent for a recipient-removed email (the recipient row is gone).
    recipientId: z.number().optional(),
    recipientEmail: z.string(),
    recipientName: z.string(),
    recipientRole: z.string(),
    // Solid Ten Sign (N-6): reminders, cancellation and recipient-removed mails stopped by the limit.
    emailType: z.enum(['SIGNING_REQUEST', 'DOCUMENT_COMPLETED', 'REMINDER', 'DOCUMENT_CANCELLED', 'RECIPIENT_REMOVED']),
    attempts: z.number(),
    // Solid Ten Sign (K-2): LIMIT when the organisation's email limit stopped the email (not sent).
    reason: z.enum(['LIMIT']).optional(),
  }),
});

/**
 * Event: Too many wrong emailed access codes. The code check is locked until a
 * new code is requested.
 */
export const ZDocumentAuditLogEventDocumentAccessAuth2FALockedSchema = z.object({
  type: z.literal('DOCUMENT_ACCESS_AUTH_2FA_LOCKED'),
  data: z.object({
    recipientId: z.number(),
    recipientName: z.string(),
    recipientEmail: z.string(),
    failedAttempts: z.number(),
  }),
});

/**
 * Event: The final PDF (the seal) could not be made after every attempt. Written once per
 * envelope; the seal sweep keeps trying for 6 hours after the last signature (S-2).
 */
export const ZDocumentAuditLogEventDocumentSealFailedSchema = z.object({
  type: z.literal('DOCUMENT_SEAL_FAILED'),
  data: z.object({
    attempts: z.number(),
    isRejected: z.boolean(),
  }),
});

/**
 * Event (N-1): a visitor's direct-link submission was refused because the template is not set
 * up for it (for example every signature field of a signer has a condition). Written on the
 * template, so its owner sees it on the template page. Holds no visitor data.
 */
export const ZDocumentAuditLogEventDirectLinkSubmissionRefusedSchema = z.object({
  type: z.literal('DIRECT_LINK_SUBMISSION_REFUSED'),
  data: z.object({
    problem: z.string(),
  }),
});

export const ZSolidTenDocumentAuditLogEventSchemas = [
  ZDocumentAuditLogEventDocumentSendScheduledSchema,
  ZDocumentAuditLogEventDocumentSendUnscheduledSchema,
  ZDocumentAuditLogEventDocumentScheduledSendFailedSchema,
  ZDocumentAuditLogEventRecipientReassignedSchema,
  ZDocumentAuditLogEventDocumentRetentionAppliedSchema,
  ZDocumentAuditLogEventDocumentPublicFormSubmittedSchema,
  ZDocumentAuditLogEventFieldFileUploadedSchema,
  ZDocumentAuditLogEventFieldFileReplacedSchema,
  ZDocumentAuditLogEventFieldFileRemovedSchema,
  ZDocumentAuditLogEventInPersonSessionStartedSchema,
  ZDocumentAuditLogEventInPersonSignerStartedSchema,
  ZDocumentAuditLogEventInPersonSessionEndedSchema,
  ZDocumentAuditLogEventCommentCreatedSchema,
  ZDocumentAuditLogEventCommentThreadResolvedSchema,
  ZDocumentAuditLogEventCommentSettingsUpdatedSchema,
  ZDocumentAuditLogEventFieldFileDownloadedSchema,
  ZDocumentAuditLogEventEmailNotDeliveredSchema,
  ZDocumentAuditLogEventDocumentAccessAuth2FALockedSchema,
  ZDocumentAuditLogEventDocumentSealFailedSchema,
  ZDocumentAuditLogEventDirectLinkSubmissionRefusedSchema,
] as const;
