import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { getEnvelopeWhereInput } from '@documenso/lib/server-only/envelope/get-envelope-by-id';
import {
  assertMayHostInPerson,
  canHostInPerson,
  IN_PERSON_NOT_HOST_MESSAGE,
} from '@documenso/lib/server-only/in-person/assert-may-host-in-person';
import {
  beginInPersonHandover,
  confirmInPersonSigner,
  endInPersonSessionsForEnvelope,
  exitInPersonSession,
  getInPersonOptions,
  type InPersonDevice,
  sendInPersonEmailCode,
  startInPersonSession,
  stopInPersonTurn,
  unlockInPersonSession,
  verifyInPersonEmailCode,
} from '@documenso/lib/server-only/in-person/in-person-session';
import {
  inPersonEmailCodeRateLimit,
  inPersonPinRateLimit,
  inPersonSignerActionRateLimit,
} from '@documenso/lib/server-only/in-person/rate-limits';
import { assertRateLimit } from '@documenso/lib/server-only/rate-limit/rate-limit-middleware';
import { prisma } from '@documenso/prisma';
import { EnvelopeType } from '@prisma/client';

import { ZGenericSuccessResponse, ZSuccessResponseSchema } from '../schema';
import { authenticatedProcedure, maybeAuthenticatedProcedure, router } from '../trpc';
import {
  ZBeginInPersonHandoverRequestSchema,
  ZConfirmInPersonSignerRequestSchema,
  ZConfirmInPersonSignerResponseSchema,
  ZExitInPersonSessionResponseSchema,
  ZGetInPersonOptionsResponseSchema,
  ZInPersonEnvelopeRequestSchema,
  ZInPersonPinRequestSchema,
  ZInPersonSessionRequestSchema,
  ZStartInPersonSessionRequestSchema,
  ZStartInPersonSessionResponseSchema,
  ZVerifyInPersonEmailCodeRequestSchema,
} from './schema';

type MaybeAuthenticatedContext = {
  user: { id: number; name: string | null; email: string } | null;
  session: { id: string } | null;
  /** The locked sign-in, which the procedures otherwise treat as anonymous (S-L1). */
  inPersonLock?: { user: { id: number; name: string | null; email: string }; session: { id: string } } | null;
  metadata: { requestMetadata: InPersonDevice['requestMetadata'] };
};

/**
 * The in-person screens run on the host's locked sign-in. Anyone else (another
 * browser, a signed-out device) gets NOT_FOUND from the session lookup.
 */
const getDevice = (ctx: MaybeAuthenticatedContext): InPersonDevice => {
  const user = ctx.inPersonLock?.user ?? ctx.user;
  const session = ctx.inPersonLock?.session ?? ctx.session;

  if (!user || !session) {
    throw new AppError(AppErrorCode.NOT_FOUND, {
      message: 'This in-person signing session has ended.',
    });
  }

  return {
    host: { id: user.id, name: user.name, email: user.email },
    authSessionId: session.id,
    requestMetadata: ctx.metadata.requestMetadata,
  };
};

const assertSignerActionRateLimit = async (ctx: MaybeAuthenticatedContext, sessionId: string) => {
  assertRateLimit(
    await inPersonSignerActionRateLimit.check({
      ip: ctx.metadata.requestMetadata?.ipAddress ?? 'unknown',
      identifier: sessionId,
    }),
  );
};

const findEnvelopeForUser = async ({
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

  const envelope = await prisma.envelope.findFirst({
    where: envelopeWhereInput,
    select: { id: true },
  });

  if (!envelope) {
    throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Document not found' });
  }

  return envelope;
};

export const inPersonRouter = router({
  /**
   * What the "Sign in person" dialog on the document page offers.
   */
  getOptions: authenticatedProcedure
    .input(ZInPersonEnvelopeRequestSchema)
    .output(ZGetInPersonOptionsResponseSchema)
    .query(async ({ input, ctx }) => {
      const envelope = await findEnvelopeForUser({
        envelopeId: input.envelopeId,
        userId: ctx.user.id,
        teamId: ctx.teamId,
      });

      const options = await getInPersonOptions({ envelopeId: envelope.id, host: ctx.user });

      // Solid Ten Sign (S-L1): only the owner or a team admin or manager may host.
      if (options.isAvailable && !(await canHostInPerson({ envelopeId: envelope.id, userId: ctx.user.id }))) {
        return { ...options, isAvailable: false, unavailableReason: IN_PERSON_NOT_HOST_MESSAGE };
      }

      return options;
    }),

  start: authenticatedProcedure
    .input(ZStartInPersonSessionRequestSchema)
    .output(ZStartInPersonSessionResponseSchema)
    .mutation(async ({ input, ctx }) => {
      ctx.logger.info({ input: { envelopeId: input.envelopeId } });

      const envelope = await findEnvelopeForUser({
        envelopeId: input.envelopeId,
        userId: ctx.user.id,
        teamId: ctx.teamId,
      });

      await assertMayHostInPerson({ envelopeId: envelope.id, userId: ctx.user.id });

      return await startInPersonSession({
        envelopeId: envelope.id,
        host: ctx.user,
        authSessionId: getDevice(ctx).authSessionId,
        requestMetadata: ctx.metadata.requestMetadata,
        pin: input.pin,
        emailCodeRecipientIds: input.emailCodeRecipientIds,
      });
    }),

  /**
   * End running sessions from another browser (forgotten PIN, device left behind).
   */
  endForEnvelope: authenticatedProcedure
    .input(ZInPersonEnvelopeRequestSchema)
    .output(ZSuccessResponseSchema)
    .mutation(async ({ input, ctx }) => {
      ctx.logger.info({ input: { envelopeId: input.envelopeId } });

      const envelope = await findEnvelopeForUser({
        envelopeId: input.envelopeId,
        userId: ctx.user.id,
        teamId: ctx.teamId,
      });

      await endInPersonSessionsForEnvelope({
        envelopeId: envelope.id,
        actor: ctx.user,
        requestMetadata: ctx.metadata.requestMetadata,
      });

      return ZGenericSuccessResponse;
    }),

  beginHandover: maybeAuthenticatedProcedure
    .input(ZBeginInPersonHandoverRequestSchema)
    .output(ZSuccessResponseSchema)
    .mutation(async ({ input, ctx }) => {
      await assertSignerActionRateLimit(ctx, input.sessionId);

      await beginInPersonHandover({
        sessionId: input.sessionId,
        device: getDevice(ctx),
        recipientId: input.recipientId,
      });

      return ZGenericSuccessResponse;
    }),

  confirmSigner: maybeAuthenticatedProcedure
    .input(ZConfirmInPersonSignerRequestSchema)
    .output(ZConfirmInPersonSignerResponseSchema)
    .mutation(async ({ input, ctx }) => {
      await assertSignerActionRateLimit(ctx, input.sessionId);

      const device = getDevice(ctx);

      return await confirmInPersonSigner({ sessionId: input.sessionId, device, typedName: input.name });
    }),

  resendEmailCode: maybeAuthenticatedProcedure
    .input(ZInPersonSessionRequestSchema)
    .output(ZSuccessResponseSchema)
    .mutation(async ({ input, ctx }) => {
      assertRateLimit(
        await inPersonEmailCodeRateLimit.check({
          ip: ctx.metadata.requestMetadata?.ipAddress ?? 'unknown',
          identifier: input.sessionId,
        }),
      );

      await sendInPersonEmailCode({ sessionId: input.sessionId, device: getDevice(ctx) });

      return ZGenericSuccessResponse;
    }),

  verifyEmailCode: maybeAuthenticatedProcedure
    .input(ZVerifyInPersonEmailCodeRequestSchema)
    .output(ZSuccessResponseSchema)
    .mutation(async ({ input, ctx }) => {
      assertRateLimit(
        await inPersonPinRateLimit.check({
          ip: ctx.metadata.requestMetadata?.ipAddress ?? 'unknown',
          identifier: `code:${input.sessionId}`,
        }),
      );

      await verifyInPersonEmailCode({ sessionId: input.sessionId, device: getDevice(ctx), code: input.code });

      return ZGenericSuccessResponse;
    }),

  stopTurn: maybeAuthenticatedProcedure
    .input(ZInPersonSessionRequestSchema)
    .output(ZSuccessResponseSchema)
    .mutation(async ({ input, ctx }) => {
      await assertSignerActionRateLimit(ctx, input.sessionId);

      await stopInPersonTurn({ sessionId: input.sessionId, device: getDevice(ctx) });

      return ZGenericSuccessResponse;
    }),

  unlock: maybeAuthenticatedProcedure
    .input(ZInPersonPinRequestSchema)
    .output(ZSuccessResponseSchema)
    .mutation(async ({ input, ctx }) => {
      assertRateLimit(
        await inPersonPinRateLimit.check({
          ip: ctx.metadata.requestMetadata?.ipAddress ?? 'unknown',
          identifier: input.sessionId,
        }),
      );

      await unlockInPersonSession({ sessionId: input.sessionId, device: getDevice(ctx), pin: input.pin });

      return ZGenericSuccessResponse;
    }),

  exit: maybeAuthenticatedProcedure
    .input(ZInPersonPinRequestSchema)
    .output(ZExitInPersonSessionResponseSchema)
    .mutation(async ({ input, ctx }) => {
      assertRateLimit(
        await inPersonPinRateLimit.check({
          ip: ctx.metadata.requestMetadata?.ipAddress ?? 'unknown',
          identifier: input.sessionId,
        }),
      );

      return await exitInPersonSession({ sessionId: input.sessionId, device: getDevice(ctx), pin: input.pin });
    }),
});
