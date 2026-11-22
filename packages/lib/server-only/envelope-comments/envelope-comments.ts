import { prisma } from '@documenso/prisma';
import type { Envelope, EnvelopeComment, EnvelopeCommentThread, Recipient } from '@prisma/client';
import {
  EnvelopeCommentAuthorType,
  EnvelopeType,
  RecipientRole,
  SigningStatus,
  WebhookTriggerEvents,
} from '@prisma/client';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { jobs } from '../../jobs/client';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../types/document-audit-logs';
import { isTspEnvelope } from '../../types/signature-level';
import { mapEnvelopeToWebhookDocumentPayload, ZWebhookDocumentSchema } from '../../types/webhook-payload';
import type { ApiRequestMetadata, RequestMetadata } from '../../universal/extract-request-metadata';
import { createDocumentAuditLogData } from '../../utils/document-audit-logs';
import {
  COMMENT_MAX_LENGTH,
  COMMENTS_CLOSED_MESSAGES,
  countUnreadRecipientComments,
  getCommentBodyError,
  getCommentsClosedReason,
  getRecipientCommentThreadKey,
  getRecipientVisibleThreadKeys,
  normaliseCommentBody,
  resolveEnvelopeCommentSettings,
  SHARED_COMMENT_THREAD_KEY,
} from '../../utils/envelope-comments';
import { isRecipientAuthorized } from '../document/is-recipient-authorized';
import { getTeamSettings } from '../team/get-team-settings';
import { triggerWebhook } from '../webhooks/trigger/trigger-webhook';

type CommentView = {
  id: string;
  authorType: EnvelopeCommentAuthorType;
  authorName: string;
  isOwn: boolean;
  body: string;
  createdAt: Date;
};

const toCommentView = (comment: EnvelopeComment, ownRecipientId: number | null): CommentView => ({
  id: comment.id,
  authorType: comment.authorType,
  authorName: comment.authorName || comment.authorEmail,
  isOwn: ownRecipientId !== null && comment.authorRecipientId === ownRecipientId,
  body: comment.body,
  createdAt: comment.createdAt,
});

export const getEnvelopeCommentSettings = async (envelope: Pick<Envelope, 'id' | 'teamId'>) => {
  const [envelopeSettings, teamSettings] = await Promise.all([
    prisma.envelopeCommentSettings.findUnique({ where: { envelopeId: envelope.id } }),
    getTeamSettings({ teamId: envelope.teamId }),
  ]);

  return resolveEnvelopeCommentSettings({
    envelopeSettings: envelopeSettings
      ? { enabled: envelopeSettings.enabled, sharedThread: envelopeSettings.sharedThread }
      : null,
    teamSettings,
  });
};

const assertBody = (raw: string) => {
  const body = normaliseCommentBody(raw);

  const error = getCommentBodyError(body);

  if (error === 'EMPTY') {
    throw new AppError(AppErrorCode.INVALID_BODY, { message: 'Write a comment first.' });
  }

  if (error === 'TOO_LONG') {
    throw new AppError(AppErrorCode.INVALID_BODY, {
      message: `Comments can be at most ${COMMENT_MAX_LENGTH} characters.`,
    });
  }

  return body;
};

const assertEnvelopeSupportsComments = (envelope: Envelope) => {
  if (envelope.internalVersion !== 2) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Comments are not available for documents created with the older editor.',
    });
  }

  if (isTspEnvelope(envelope)) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Comments are not available for documents that need an advanced or qualified signature.',
    });
  }
};

const assertOpen = (envelope: Envelope) => {
  const closedReason = getCommentsClosedReason(envelope);

  if (closedReason) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, { message: COMMENTS_CLOSED_MESSAGES[closedReason] });
  }
};

/**
 * The recipient behind a signing link, checked the way the signing page checks it.
 */
const loadRecipientForComments = async ({ token, userId }: { token: string; userId?: number }) => {
  const recipient = await prisma.recipient.findFirst({
    where: { token, envelope: { type: EnvelopeType.DOCUMENT } },
    include: { envelope: true },
  });

  if (!recipient || recipient.role === RecipientRole.CC) {
    throw new AppError(AppErrorCode.NOT_FOUND, { message: 'This signing link is no longer valid.' });
  }

  const isAuthorized = await isRecipientAuthorized({
    type: 'ACCESS',
    documentAuthOptions: recipient.envelope.authOptions,
    recipient,
    userId,
  });

  if (!isAuthorized) {
    throw new AppError(AppErrorCode.UNAUTHORIZED, { message: 'Sign in to read the comments on this document.' });
  }

  return recipient;
};

/**
 * What a signer sees: their own thread, plus the shared one when the sender
 * chose a single thread for everyone. Never another recipient's thread.
 */
export const getCommentsForRecipient = async ({ token, userId }: { token: string; userId?: number }) => {
  const recipient = await loadRecipientForComments({ token, userId });
  const { envelope } = recipient;

  const settings = await getEnvelopeCommentSettings(envelope);

  const isSupported = envelope.internalVersion === 2 && !isTspEnvelope(envelope);

  if (!settings.enabled || !isSupported) {
    return { enabled: false as const };
  }

  const closedReason = getCommentsClosedReason(envelope);

  const threads = await prisma.envelopeCommentThread.findMany({
    where: {
      envelopeId: envelope.id,
      key: { in: getRecipientVisibleThreadKeys({ recipient, sharedThread: settings.sharedThread }) },
    },
    include: { comments: { orderBy: { createdAt: 'asc' } } },
  });

  const comments = threads
    .flatMap((thread) => thread.comments)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((comment) => toCommentView(comment, recipient.id));

  return {
    enabled: true as const,
    sharedThread: settings.sharedThread,
    isClosed: closedReason !== null || recipient.signingStatus !== SigningStatus.NOT_SIGNED,
    closedMessage: closedReason ? COMMENTS_CLOSED_MESSAGES[closedReason] : null,
    maxLength: COMMENT_MAX_LENGTH,
    comments,
  };
};

const findOrCreateThread = async ({
  envelopeId,
  key,
  recipient,
}: {
  envelopeId: string;
  key: string;
  recipient: Pick<Recipient, 'id' | 'email' | 'name'> | null;
}) =>
  await prisma.envelopeCommentThread.upsert({
    where: { envelopeId_key: { envelopeId, key } },
    create: {
      envelopeId,
      key,
      recipientId: recipient?.id ?? null,
      recipientEmail: recipient?.email ?? null,
      recipientName: recipient?.name ?? null,
    },
    update: {},
  });

type CreateCommentOptions = {
  envelope: Envelope;
  thread: EnvelopeCommentThread;
  body: string;
  author:
    | { type: 'RECIPIENT'; recipient: Recipient; requestMetadata?: RequestMetadata }
    | { type: 'TEAM'; user: { id: number; name: string | null; email: string }; metadata: ApiRequestMetadata };
};

const createComment = async ({ envelope, thread, body, author }: CreateCommentOptions) => {
  const now = new Date();

  const authorName = author.type === 'RECIPIENT' ? author.recipient.name : (author.user.name ?? '');
  const authorEmail = author.type === 'RECIPIENT' ? author.recipient.email : author.user.email;

  const comment = await prisma.$transaction(async (tx) => {
    const created = await tx.envelopeComment.create({
      data: {
        threadId: thread.id,
        envelopeId: envelope.id,
        authorType: author.type === 'RECIPIENT' ? EnvelopeCommentAuthorType.RECIPIENT : EnvelopeCommentAuthorType.TEAM,
        authorRecipientId: author.type === 'RECIPIENT' ? author.recipient.id : null,
        authorUserId: author.type === 'TEAM' ? author.user.id : null,
        authorName,
        authorEmail,
        body,
        createdAt: now,
      },
    });

    await tx.envelopeCommentThread.update({
      where: { id: thread.id },
      data: {
        lastCommentAt: now,
        // A new question reopens a resolved thread; a team reply counts as read.
        ...(author.type === 'RECIPIENT' ? { resolvedAt: null, resolvedByUserId: null } : { teamReadAt: now }),
      },
    });

    await tx.documentAuditLog.create({
      data: createDocumentAuditLogData({
        type: DOCUMENT_AUDIT_LOG_TYPE.COMMENT_CREATED,
        envelopeId: envelope.id,
        user:
          author.type === 'RECIPIENT'
            ? { name: author.recipient.name, email: author.recipient.email }
            : { id: author.user.id, name: author.user.name, email: author.user.email },
        requestMetadata: author.type === 'RECIPIENT' ? author.requestMetadata : undefined,
        metadata: author.type === 'TEAM' ? author.metadata : undefined,
        data: {
          commentId: created.id,
          threadId: thread.id,
          isSharedThread: thread.key === SHARED_COMMENT_THREAD_KEY,
          threadRecipientId: thread.recipientId,
          authorType: created.authorType,
          authorRecipientId: created.authorRecipientId,
          length: body.length,
        },
      }),
    });

    return created;
  });

  const webhookEnvelope = await prisma.envelope.findFirstOrThrow({
    where: { id: envelope.id },
    include: { documentMeta: true, recipients: true },
  });

  await triggerWebhook({
    event: WebhookTriggerEvents.DOCUMENT_COMMENT_CREATED,
    data: {
      ...ZWebhookDocumentSchema.parse(mapEnvelopeToWebhookDocumentPayload(webhookEnvelope)),
      comment: {
        id: comment.id,
        threadId: thread.id,
        isSharedThread: thread.key === SHARED_COMMENT_THREAD_KEY,
        authorType: comment.authorType,
        authorName: comment.authorName,
        authorEmail: comment.authorEmail,
        recipientId: comment.authorRecipientId,
        body: comment.body,
        createdAt: comment.createdAt.toISOString(),
      },
    },
    userId: envelope.userId,
    teamId: envelope.teamId,
  });

  return comment;
};

/**
 * A signer asks a question or leaves a note before signing.
 */
export const postRecipientComment = async ({
  token,
  userId,
  body: rawBody,
  requestMetadata,
}: {
  token: string;
  userId?: number;
  body: string;
  requestMetadata?: RequestMetadata;
}) => {
  const recipient = await loadRecipientForComments({ token, userId });
  const { envelope } = recipient;

  assertEnvelopeSupportsComments(envelope);
  assertOpen(envelope);

  const settings = await getEnvelopeCommentSettings(envelope);

  if (!settings.enabled) {
    throw new AppError(AppErrorCode.FORBIDDEN, { message: 'Comments are turned off for this document.' });
  }

  if (recipient.signingStatus !== SigningStatus.NOT_SIGNED) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, { message: 'You have already finished with this document.' });
  }

  const body = assertBody(rawBody);

  const thread = settings.sharedThread
    ? await findOrCreateThread({ envelopeId: envelope.id, key: SHARED_COMMENT_THREAD_KEY, recipient: null })
    : await findOrCreateThread({
        envelopeId: envelope.id,
        key: getRecipientCommentThreadKey(recipient),
        recipient,
      });

  const comment = await createComment({
    envelope,
    thread,
    body,
    author: { type: 'RECIPIENT', recipient, requestMetadata },
  });

  await jobs.triggerJob({
    name: 'send.solidten.notice.email',
    payload: { kind: 'COMMENT_FROM_RECIPIENT', envelopeId: envelope.id, commentId: comment.id },
  });

  return toCommentView(comment, recipient.id);
};

/**
 * Every thread on the document, for the sender's team.
 * The caller has checked that the user may see the envelope.
 */
export const getCommentsForTeam = async ({ envelopeId }: { envelopeId: string }) => {
  const envelope = await prisma.envelope.findUniqueOrThrow({
    where: { id: envelopeId },
    include: { recipients: { select: { id: true, name: true, email: true, role: true } } },
  });

  const settings = await getEnvelopeCommentSettings(envelope);
  const closedReason = getCommentsClosedReason(envelope);

  const threads = await prisma.envelopeCommentThread.findMany({
    where: { envelopeId },
    include: { comments: { orderBy: { createdAt: 'asc' } } },
    orderBy: { lastCommentAt: 'desc' },
  });

  return {
    settings: { enabled: settings.enabled, sharedThread: settings.sharedThread, isTeamDefault: settings.isTeamDefault },
    isSupported: envelope.internalVersion === 2 && !isTspEnvelope(envelope),
    isClosed: closedReason !== null,
    closedMessage: closedReason ? COMMENTS_CLOSED_MESSAGES[closedReason] : null,
    maxLength: COMMENT_MAX_LENGTH,
    unreadCount: threads.reduce(
      (total, thread) =>
        total + countUnreadRecipientComments({ comments: thread.comments, teamReadAt: thread.teamReadAt }),
      0,
    ),
    threads: threads.map((thread) => {
      const current = envelope.recipients.find((r) => r.id === thread.recipientId);

      return {
        id: thread.id,
        isShared: thread.key === SHARED_COMMENT_THREAD_KEY,
        recipientName: thread.recipientName || thread.recipientEmail || '',
        recipientEmail: thread.recipientEmail,
        /** The recipient was reassigned to someone else after this thread started. */
        isPreviousRecipient: Boolean(
          thread.recipientId && (!current || current.email.toLowerCase() !== thread.recipientEmail?.toLowerCase()),
        ),
        resolvedAt: thread.resolvedAt,
        unreadCount: countUnreadRecipientComments({ comments: thread.comments, teamReadAt: thread.teamReadAt }),
        comments: thread.comments.map((comment) => toCommentView(comment, null)),
      };
    }),
  };
};

const loadThreadForTeam = async ({ envelopeId, threadId }: { envelopeId: string; threadId: string }) => {
  const thread = await prisma.envelopeCommentThread.findFirst({
    where: { id: threadId, envelopeId },
    include: { envelope: true },
  });

  if (!thread) {
    throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Comment thread not found.' });
  }

  return thread;
};

/**
 * Someone on the team replies in a thread.
 */
export const postTeamComment = async ({
  envelopeId,
  threadId,
  body: rawBody,
  user,
  metadata,
}: {
  envelopeId: string;
  threadId: string;
  body: string;
  user: { id: number; name: string | null; email: string };
  metadata: ApiRequestMetadata;
}) => {
  const { envelope, ...thread } = await loadThreadForTeam({ envelopeId, threadId });

  assertEnvelopeSupportsComments(envelope);
  assertOpen(envelope);

  const settings = await getEnvelopeCommentSettings(envelope);

  if (!settings.enabled) {
    throw new AppError(AppErrorCode.FORBIDDEN, { message: 'Comments are turned off for this document.' });
  }

  const body = assertBody(rawBody);

  const comment = await createComment({ envelope, thread, body, author: { type: 'TEAM', user, metadata } });

  // Who can read this thread: its recipient, or everyone on a shared thread.
  const recipients = await prisma.recipient.findMany({
    where: {
      envelopeId,
      role: { not: RecipientRole.CC },
      signingStatus: SigningStatus.NOT_SIGNED,
      ...(thread.key === SHARED_COMMENT_THREAD_KEY ? {} : { id: thread.recipientId ?? -1 }),
    },
  });

  const readers = recipients.filter(
    (recipient) => thread.key === SHARED_COMMENT_THREAD_KEY || getRecipientCommentThreadKey(recipient) === thread.key,
  );

  for (const recipient of readers) {
    await jobs.triggerJob({
      name: 'send.solidten.notice.email',
      payload: { kind: 'COMMENT_FROM_TEAM', envelopeId, commentId: comment.id, recipientId: recipient.id },
    });
  }

  return toCommentView(comment, null);
};

export const setCommentThreadResolved = async ({
  envelopeId,
  threadId,
  resolved,
  user,
  metadata,
}: {
  envelopeId: string;
  threadId: string;
  resolved: boolean;
  user: { id: number };
  metadata: ApiRequestMetadata;
}) => {
  const thread = await loadThreadForTeam({ envelopeId, threadId });

  if (Boolean(thread.resolvedAt) === resolved) {
    return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.envelopeCommentThread.update({
      where: { id: thread.id },
      data: resolved
        ? { resolvedAt: new Date(), resolvedByUserId: user.id, teamReadAt: new Date() }
        : { resolvedAt: null, resolvedByUserId: null },
    });

    await tx.documentAuditLog.create({
      data: createDocumentAuditLogData({
        type: DOCUMENT_AUDIT_LOG_TYPE.COMMENT_THREAD_RESOLVED,
        envelopeId,
        metadata,
        data: { threadId: thread.id, threadRecipientId: thread.recipientId, resolved },
      }),
    });
  });
};

export const markCommentThreadsRead = async ({ envelopeId }: { envelopeId: string }) => {
  await prisma.envelopeCommentThread.updateMany({
    where: { envelopeId },
    data: { teamReadAt: new Date() },
  });
};

export const updateEnvelopeCommentSettings = async ({
  envelopeId,
  enabled,
  sharedThread,
  metadata,
}: {
  envelopeId: string;
  enabled: boolean;
  sharedThread: boolean;
  metadata: ApiRequestMetadata;
}) => {
  const envelope = await prisma.envelope.findUniqueOrThrow({ where: { id: envelopeId } });

  assertEnvelopeSupportsComments(envelope);

  const closedReason = getCommentsClosedReason(envelope);

  if (closedReason && closedReason !== 'NOT_SENT') {
    throw new AppError(AppErrorCode.INVALID_REQUEST, { message: COMMENTS_CLOSED_MESSAGES[closedReason] });
  }

  await prisma.$transaction(async (tx) => {
    await tx.envelopeCommentSettings.upsert({
      where: { envelopeId },
      create: { envelopeId, enabled, sharedThread },
      update: { enabled, sharedThread },
    });

    await tx.documentAuditLog.create({
      data: createDocumentAuditLogData({
        type: DOCUMENT_AUDIT_LOG_TYPE.COMMENT_SETTINGS_UPDATED,
        envelopeId,
        metadata,
        data: { enabled, sharedThread },
      }),
    });
  });
};

export type TTeamCommentThread = Awaited<ReturnType<typeof getCommentsForTeam>>['threads'][number];
