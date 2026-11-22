import type { Envelope } from '@prisma/client';
import { DocumentStatus } from '@prisma/client';

export const COMMENT_MAX_LENGTH = 2000;

export const SHARED_COMMENT_THREAD_KEY = 'shared';

/**
 * The thread key for one recipient. It includes the email, so a recipient row
 * reassigned to another person starts a new thread and the new person never
 * reads the old person's conversation.
 */
export const getRecipientCommentThreadKey = (recipient: { id: number; email: string }) =>
  `recipient:${recipient.id}:${recipient.email.trim().toLowerCase()}`;

/**
 * Plain text only. Removes control characters (keeps line breaks and tabs),
 * trims, and squeezes runs of blank lines. HTML stays as typed: it is always
 * shown as text.
 */
export const normaliseCommentBody = (raw: string) =>
  raw
    .replace(/\r\n?/g, '\n')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters is the point.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

export type CommentBodyError = 'EMPTY' | 'TOO_LONG';

export const getCommentBodyError = (body: string): CommentBodyError | null => {
  if (body.length === 0) {
    return 'EMPTY';
  }

  if (body.length > COMMENT_MAX_LENGTH) {
    return 'TOO_LONG';
  }

  return null;
};

export type CommentsClosedReason = 'NOT_SENT' | 'COMPLETED' | 'REJECTED' | 'CANCELLED' | 'DELETED';

export const COMMENTS_CLOSED_MESSAGES: Record<CommentsClosedReason, string> = {
  NOT_SENT: 'Comments open when the document is sent.',
  COMPLETED: 'Comments are closed because the document is complete.',
  REJECTED: 'Comments are closed because the document was rejected.',
  CANCELLED: 'Comments are closed because the document was cancelled.',
  DELETED: 'Comments are closed because the document was deleted.',
};

/**
 * Comments are open only while the document waits for signatures.
 *
 * Documents created from a public form follow the same rules on purpose. The
 * form's submitter has already signed, so they cannot post (signers can post
 * only before they finish), and a form without email verification sends no
 * recipient email, so reply notices are not sent for it either.
 */
export const getCommentsClosedReason = (
  envelope: Pick<Envelope, 'status' | 'deletedAt'>,
): CommentsClosedReason | null => {
  if (envelope.deletedAt) {
    return 'DELETED';
  }

  switch (envelope.status) {
    case DocumentStatus.PENDING:
      return null;
    case DocumentStatus.DRAFT:
      return 'NOT_SENT';
    case DocumentStatus.COMPLETED:
      return 'COMPLETED';
    case DocumentStatus.REJECTED:
      return 'REJECTED';
    default:
      return 'CANCELLED';
  }
};

export type TEnvelopeCommentSettings = {
  enabled: boolean;
  sharedThread: boolean;
};

/**
 * The document's own choice, or the team default when the sender made none.
 */
export const resolveEnvelopeCommentSettings = ({
  envelopeSettings,
  teamSettings,
}: {
  envelopeSettings: TEnvelopeCommentSettings | null;
  teamSettings: { commentsEnabled: boolean; commentsSharedThread: boolean };
}): TEnvelopeCommentSettings & { isTeamDefault: boolean } => {
  if (envelopeSettings) {
    return { ...envelopeSettings, isTeamDefault: false };
  }

  return {
    enabled: teamSettings.commentsEnabled,
    sharedThread: teamSettings.commentsSharedThread,
    isTeamDefault: true,
  };
};

/**
 * Which threads a recipient may read: always their own, and the shared thread
 * while the document uses one.
 */
export const getRecipientVisibleThreadKeys = ({
  recipient,
  sharedThread,
}: {
  recipient: { id: number; email: string };
  sharedThread: boolean;
}) => {
  const keys = [getRecipientCommentThreadKey(recipient)];

  if (sharedThread) {
    keys.push(SHARED_COMMENT_THREAD_KEY);
  }

  return keys;
};

/**
 * Recipient comments the team has not read yet.
 */
export const countUnreadRecipientComments = ({
  comments,
  teamReadAt,
}: {
  comments: { authorType: 'RECIPIENT' | 'TEAM'; createdAt: Date }[];
  teamReadAt: Date | null;
}) =>
  comments.filter((comment) => comment.authorType === 'RECIPIENT' && (!teamReadAt || comment.createdAt > teamReadAt))
    .length;
