import { prisma } from '@documenso/prisma';

import { DOCUMENT_AUDIT_LOG_TYPE } from '../../types/document-audit-logs';

// Kept light: the audit-log PDF and the retention purge import this.

/**
 * Fill in the comment text for COMMENT_CREATED entries, for the audit-log PDF.
 * The text lives in the comment row, not in the audit data.
 */
export const attachCommentBodiesToAuditLogs = async <T extends { type: string; data: unknown }>(auditLogs: T[]) => {
  const commentIds = auditLogs.flatMap((log) =>
    log.type === DOCUMENT_AUDIT_LOG_TYPE.COMMENT_CREATED &&
    typeof log.data === 'object' &&
    log.data !== null &&
    'commentId' in log.data &&
    typeof log.data.commentId === 'string'
      ? [log.data.commentId]
      : [],
  );

  if (commentIds.length === 0) {
    return auditLogs;
  }

  const comments = await prisma.envelopeComment.findMany({
    where: { id: { in: commentIds } },
    select: { id: true, body: true },
  });

  const bodies = new Map(comments.map((comment) => [comment.id, comment.body]));

  return auditLogs.map((log) => {
    if (log.type !== DOCUMENT_AUDIT_LOG_TYPE.COMMENT_CREATED || typeof log.data !== 'object' || log.data === null) {
      return log;
    }

    const commentId = 'commentId' in log.data ? log.data.commentId : null;
    const body = typeof commentId === 'string' ? bodies.get(commentId) : undefined;

    return body === undefined ? log : { ...log, data: { ...log.data, body } };
  });
};

/**
 * Remove every comment on an envelope. Used by the retention purge.
 */
export const deleteEnvelopeComments = async (
  tx: Pick<typeof prisma, 'envelopeCommentThread' | 'envelopeCommentSettings'>,
  envelopeId: string,
) => {
  await tx.envelopeCommentThread.deleteMany({ where: { envelopeId } });
  await tx.envelopeCommentSettings.deleteMany({ where: { envelopeId } });
};
