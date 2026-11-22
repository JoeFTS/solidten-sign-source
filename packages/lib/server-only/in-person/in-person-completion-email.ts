import { prisma } from '@documenso/prisma';
import type { DocumentMeta } from '@prisma/client';
import { DocumentDistributionMethod } from '@prisma/client';

import { DOCUMENT_AUDIT_LOG_TYPE } from '../../types/document-audit-logs';
import { ZDocumentEmailSettingsSchema } from '../../types/document-email';
import { getInPersonHostFromAuditLog } from '../../utils/in-person-audit';

/**
 * Recipients who signed in person on a document sent without emails. They still
 * get the completed copy by email, unless the sender turned the completion email off.
 * On documents sent by email the normal rules already cover them.
 */
export const getInPersonCompletionEmailRecipientIds = async ({
  envelope,
}: {
  envelope: { id: string; documentMeta: DocumentMeta | null };
}) => {
  if (envelope.documentMeta?.distributionMethod !== DocumentDistributionMethod.NONE) {
    return [];
  }

  const ownSettings = ZDocumentEmailSettingsSchema.parse(envelope.documentMeta.emailSettings ?? {});

  if (!ownSettings.documentCompleted) {
    return [];
  }

  const completedLogs = await prisma.documentAuditLog.findMany({
    where: { envelopeId: envelope.id, type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_RECIPIENT_COMPLETED },
    select: { type: true, data: true },
  });

  return completedLogs.flatMap((log) => {
    if (!getInPersonHostFromAuditLog(log)) {
      return [];
    }

    const recipientId =
      typeof log.data === 'object' && log.data && 'recipientId' in log.data ? log.data.recipientId : null;

    return typeof recipientId === 'number' ? [recipientId] : [];
  });
};
