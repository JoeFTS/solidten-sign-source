import type { TDocumentAuditLog } from '../types/document-audit-logs';
import type { TRecipientAccessAuthTypes } from '../types/document-auth';

/**
 * Solid Ten (AUD-8): the access methods recorded on the recipient's completed or rejected audit
 * row, if any. The certificate prints these, not the envelope settings at seal time; a row without
 * the field (documents from before the record) returns undefined so the caller falls back.
 */
export const getRecordedAccessAuth = (
  logs: TDocumentAuditLog[],
  recipientId: number,
): TRecipientAccessAuthTypes[] | undefined => {
  for (const log of logs) {
    if (
      (log.type === 'DOCUMENT_RECIPIENT_COMPLETED' || log.type === 'DOCUMENT_RECIPIENT_REJECTED') &&
      log.data.recipientId === recipientId &&
      log.data.accessAuth
    ) {
      return log.data.accessAuth;
    }
  }

  return undefined;
};
