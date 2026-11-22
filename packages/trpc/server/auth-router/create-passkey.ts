import { createPasskey } from '@documenso/lib/server-only/auth/create-passkey';
import {
  assertSessionFreshForCredentialChange,
  assertTwoFactorForCredentialChange,
  revokeOtherUserSessions,
} from '@documenso/lib/server-only/auth/credential-step-up';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';

import { authenticatedProcedure } from '../trpc';
import { ZCreatePasskeyRequestSchema, ZCreatePasskeyResponseSchema } from './create-passkey.types';

export const createPasskeyRoute = authenticatedProcedure
  .input(ZCreatePasskeyRequestSchema)
  .output(ZCreatePasskeyResponseSchema)
  .mutation(async ({ ctx, input }) => {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const verificationResponse = input.verificationResponse as RegistrationResponseJSON;

    // tRPC types ctx.session from the API-token branch (null); a browser sign-in has the row.
    const session = (ctx as { session?: { id: string; createdAt: Date } | null }).session ?? null;

    // Solid Ten Sign (AUD-C10): a recent sign-in, and the 2FA code when 2FA is on.
    assertSessionFreshForCredentialChange(session);
    await assertTwoFactorForCredentialChange({ userId: ctx.user.id, twoFactorCode: input.twoFactorCode });

    await createPasskey({
      userId: ctx.user.id,
      verificationResponse,
      passkeyName: input.passkeyName,
      requestMetadata: ctx.metadata.requestMetadata,
    });

    await revokeOtherUserSessions({ userId: ctx.user.id, currentSessionId: session?.id });
  });
