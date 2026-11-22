import {
  assertCredentialChangeStepUp,
  revokeOtherUserSessions,
} from '@documenso/lib/server-only/auth/credential-step-up';
import { deletePasskey } from '@documenso/lib/server-only/auth/delete-passkey';

import { authenticatedProcedure } from '../trpc';
import { ZDeletePasskeyRequestSchema, ZDeletePasskeyResponseSchema } from './delete-passkey.types';

export const deletePasskeyRoute = authenticatedProcedure
  .input(ZDeletePasskeyRequestSchema)
  .output(ZDeletePasskeyResponseSchema)
  .mutation(async ({ ctx, input }) => {
    const { passkeyId } = input;

    ctx.logger.info({
      input: {
        passkeyId,
      },
    });

    // tRPC types ctx.session from the API-token branch (null); a browser sign-in has the row.
    const session = (ctx as { session?: { id: string; createdAt: Date; isEmbed?: boolean } | null }).session ?? null;

    // Solid Ten Sign (AUD-C10 follow-up): a recent sign-in, and the 2FA code when 2FA is on.
    await assertCredentialChangeStepUp({
      session,
      userId: ctx.user.id,
      twoFactorCode: input.twoFactorCode,
      checkTwoFactor: true,
    });

    await deletePasskey({
      userId: ctx.user.id,
      passkeyId,
      requestMetadata: ctx.metadata.requestMetadata,
    });

    // Solid Ten Sign (AUD-C10): a credential change ends the user's other sign-ins.
    await revokeOtherUserSessions({ userId: ctx.user.id, currentSessionId: session?.id });
  });
