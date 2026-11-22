import type { TRetentionSettings } from '../../utils/retention';

/**
 * Solid Ten Sign (G2): what is left of a document's audit log after a retention purge.
 *
 * The purge erases every audit-log row of the document (they hold names, email addresses, IP
 * addresses, user agents and typed values) and keeps this one record: which document it was,
 * when it was completed, how many recipients it had, and (the row's createdAt) when it was
 * purged. No title and no personal data. The row itself is written with no user, no email, no
 * IP address and the retention job's own user agent.
 *
 * `auditLogIds` stays in the event schema for records written before this change (they listed
 * the rows they were the last of); a new record lists none, as those rows are gone.
 */
export const buildPurgeRecordData = ({
  settings,
  envelope,
  erasedAuditLogCount,
  deletedObjectCount,
  keptSharedObjectCount,
}: {
  settings: Pick<TRetentionSettings, 'days'>;
  envelope: { id: string; documentId: number; completedAt: Date | null; recipientCount: number };
  erasedAuditLogCount: number;
  deletedObjectCount: number;
  keptSharedObjectCount: number;
}) => ({
  action: 'PURGE' as const,
  days: settings.days,
  completedAt: envelope.completedAt?.toISOString() ?? '',
  envelopeId: envelope.id,
  documentId: envelope.documentId,
  recipientCount: envelope.recipientCount,
  auditLogIds: [],
  erasedAuditLogCount,
  deletedObjectCount,
  keptSharedObjectCount,
});
