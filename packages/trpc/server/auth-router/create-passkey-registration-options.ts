import { createPasskeyRegistrationOptions } from '@documenso/lib/server-only/auth/create-passkey-registration-options';
import { assertSessionFreshForCredentialChange } from '@documenso/lib/server-only/auth/credential-step-up';

import { authenticatedProcedure } from '../trpc';
import {
  ZCreatePasskeyRegistrationOptionsRequestSchema,
  ZCreatePasskeyRegistrationOptionsResponseSchema,
} from './create-passkey-registration-options.types';

export const createPasskeyRegistrationOptionsRoute = authenticatedProcedure
  .input(ZCreatePasskeyRegistrationOptionsRequestSchema)
  .output(ZCreatePasskeyRegistrationOptionsResponseSchema)
  .mutation(async ({ ctx }) => {
    // Solid Ten Sign (AUD-C10): ask for a fresh sign-in before the browser prompt, not after.
    // tRPC types ctx.session from the API-token branch (null); a browser sign-in has the row.
    const session = (ctx as { session?: { id: string; createdAt: Date } | null }).session ?? null;
    assertSessionFreshForCredentialChange(session);

    return await createPasskeyRegistrationOptions({
      userId: ctx.user.id,
    });
  });
