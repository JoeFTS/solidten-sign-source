import { assertCredentialChangeStepUp } from '@documenso/lib/server-only/auth/credential-step-up';
import { updatePasskey } from '@documenso/lib/server-only/auth/update-passkey';

import { authenticatedProcedure } from '../trpc';
import { ZUpdatePasskeyRequestSchema, ZUpdatePasskeyResponseSchema } from './update-passkey.types';

export const updatePasskeyRoute = authenticatedProcedure
  .input(ZUpdatePasskeyRequestSchema)
  .output(ZUpdatePasskeyResponseSchema)
  .mutation(async ({ ctx, input }) => {
    const { passkeyId, name } = input;

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

    await updatePasskey({
      userId: ctx.user.id,
      passkeyId,
      name,
      requestMetadata: ctx.metadata.requestMetadata,
    });
  });
