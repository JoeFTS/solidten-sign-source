import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { getEnvelopeWhereInput } from '@documenso/lib/server-only/envelope/get-envelope-by-id';
import {
  getCommentsForRecipient,
  getCommentsForTeam,
  markCommentThreadsRead,
  postRecipientComment,
  postTeamComment,
  setCommentThreadResolved,
  updateEnvelopeCommentSettings,
} from '@documenso/lib/server-only/envelope-comments/envelope-comments';
import {
  recipientCommentRateLimit,
  teamCommentRateLimit,
} from '@documenso/lib/server-only/envelope-comments/rate-limits';
import { assertRateLimit } from '@documenso/lib/server-only/rate-limit/rate-limit-middleware';
import { getTokenRateLimitKey } from '@documenso/lib/server-only/rate-limit/token-rate-limit-key';
import { prisma } from '@documenso/prisma';
import { EnvelopeType } from '@prisma/client';

import { ZGenericSuccessResponse, ZSuccessResponseSchema } from '../schema';
import { authenticatedProcedure, maybeAuthenticatedProcedure, router } from '../trpc';
import {
  ZEnvelopeCommentsRequestSchema,
  ZPostRecipientCommentRequestSchema,
  ZRecipientCommentsRequestSchema,
  ZReplyToCommentThreadRequestSchema,
  ZSetCommentThreadResolvedRequestSchema,
  ZUpdateEnvelopeCommentSettingsRequestSchema,
} from './schema';

const findEnvelopeIdForUser = async ({
  envelopeId,
  userId,
  teamId,
}: {
  envelopeId: string;
  userId: number;
  teamId: number;
}) => {
  const { envelopeWhereInput } = await getEnvelopeWhereInput({
    id: { type: 'envelopeId', id: envelopeId },
    type: EnvelopeType.DOCUMENT,
    userId,
    teamId,
  });

  const envelope = await prisma.envelope.findFirst({ where: envelopeWhereInput, select: { id: true } });

  if (!envelope) {
    throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Document not found' });
  }

  return envelope.id;
};

export const commentRouter = router({
  /**
   * NOTE: PUBLIC. The signing link token authorizes it.
   */
  getForRecipient: maybeAuthenticatedProcedure.input(ZRecipientCommentsRequestSchema).query(async ({ input, ctx }) => {
    return await getCommentsForRecipient({ token: input.token, userId: ctx.user?.id });
  }),

  /**
   * NOTE: PUBLIC. The signing link token authorizes it. Rate limited by token and IP.
   */
  postAsRecipient: maybeAuthenticatedProcedure
    .input(ZPostRecipientCommentRequestSchema)
    .mutation(async ({ input, ctx }) => {
      assertRateLimit(
        await recipientCommentRateLimit.check({
          ip: ctx.metadata.requestMetadata.ipAddress ?? 'unknown',
          identifier: getTokenRateLimitKey(input.token),
        }),
      );

      return await postRecipientComment({
        token: input.token,
        userId: ctx.user?.id,
        body: input.body,
        requestMetadata: ctx.metadata.requestMetadata,
      });
    }),

  getForEnvelope: authenticatedProcedure.input(ZEnvelopeCommentsRequestSchema).query(async ({ input, ctx }) => {
    const envelopeId = await findEnvelopeIdForUser({
      envelopeId: input.envelopeId,
      userId: ctx.user.id,
      teamId: ctx.teamId,
    });

    return await getCommentsForTeam({ envelopeId });
  }),

  reply: authenticatedProcedure.input(ZReplyToCommentThreadRequestSchema).mutation(async ({ input, ctx }) => {
    ctx.logger.info({ input: { envelopeId: input.envelopeId, threadId: input.threadId } });

    assertRateLimit(
      await teamCommentRateLimit.check({
        ip: ctx.metadata.requestMetadata.ipAddress ?? 'unknown',
        identifier: String(ctx.user.id),
      }),
    );

    const envelopeId = await findEnvelopeIdForUser({
      envelopeId: input.envelopeId,
      userId: ctx.user.id,
      teamId: ctx.teamId,
    });

    return await postTeamComment({
      envelopeId,
      threadId: input.threadId,
      body: input.body,
      user: ctx.user,
      metadata: ctx.metadata,
    });
  }),

  setResolved: authenticatedProcedure
    .input(ZSetCommentThreadResolvedRequestSchema)
    .output(ZSuccessResponseSchema)
    .mutation(async ({ input, ctx }) => {
      const envelopeId = await findEnvelopeIdForUser({
        envelopeId: input.envelopeId,
        userId: ctx.user.id,
        teamId: ctx.teamId,
      });

      await setCommentThreadResolved({
        envelopeId,
        threadId: input.threadId,
        resolved: input.resolved,
        user: ctx.user,
        metadata: ctx.metadata,
      });

      return ZGenericSuccessResponse;
    }),

  markRead: authenticatedProcedure
    .input(ZEnvelopeCommentsRequestSchema)
    .output(ZSuccessResponseSchema)
    .mutation(async ({ input, ctx }) => {
      const envelopeId = await findEnvelopeIdForUser({
        envelopeId: input.envelopeId,
        userId: ctx.user.id,
        teamId: ctx.teamId,
      });

      await markCommentThreadsRead({ envelopeId });

      return ZGenericSuccessResponse;
    }),

  updateSettings: authenticatedProcedure
    .input(ZUpdateEnvelopeCommentSettingsRequestSchema)
    .output(ZSuccessResponseSchema)
    .mutation(async ({ input, ctx }) => {
      ctx.logger.info({ input: { envelopeId: input.envelopeId } });

      const envelopeId = await findEnvelopeIdForUser({
        envelopeId: input.envelopeId,
        userId: ctx.user.id,
        teamId: ctx.teamId,
      });

      await updateEnvelopeCommentSettings({
        envelopeId,
        enabled: input.enabled,
        sharedThread: input.sharedThread,
        metadata: ctx.metadata,
      });

      return ZGenericSuccessResponse;
    }),
});
