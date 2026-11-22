import type { I18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';

import { type TInPersonHostMarker, ZInPersonHostMarkerSchema } from '../types/solidten-audit-logs';

/**
 * The in-person host recorded on a recipient's completed or rejected entry, if any.
 *
 * Takes a loose shape so the certificate (which reads raw audit rows) and the
 * audit log formatter can both use it.
 */
export const getInPersonHostFromAuditLog = (auditLog: { type: string; data: unknown } | null | undefined) => {
  if (!auditLog) {
    return null;
  }

  if (auditLog.type !== 'DOCUMENT_RECIPIENT_COMPLETED' && auditLog.type !== 'DOCUMENT_RECIPIENT_REJECTED') {
    return null;
  }

  if (typeof auditLog.data !== 'object' || auditLog.data === null || !('inPersonHost' in auditLog.data)) {
    return null;
  }

  const parsed = ZInPersonHostMarkerSchema.safeParse(auditLog.data.inPersonHost);

  return parsed.success ? parsed.data : null;
};

export const formatInPersonHost = (host: Pick<TInPersonHostMarker, 'hostName' | 'hostEmail'>) => {
  return host.hostName ? `${host.hostName} (${host.hostEmail})` : host.hostEmail;
};

/**
 * Text added to an audit description when the action was hosted in person.
 * Empty for every other entry.
 */
export const formatInPersonHostSuffix = (i18n: I18n, auditLog: { type: string; data: unknown }) => {
  const host = getInPersonHostFromAuditLog(auditLog);

  if (!host) {
    return '';
  }

  const hostLabel = formatInPersonHost(host);

  return host.emailCodeVerified
    ? i18n._(msg` (in person, hosted by ${hostLabel}; email code confirmed)`)
    : i18n._(msg` (in person, hosted by ${hostLabel})`);
};
