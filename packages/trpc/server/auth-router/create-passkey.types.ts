import { ZNameSchema } from '@documenso/lib/types/name';
import { ZRegistrationResponseJSONSchema } from '@documenso/lib/types/webauthn';
import { z } from 'zod';

export const ZCreatePasskeyRequestSchema = z.object({
  passkeyName: ZNameSchema,
  verificationResponse: ZRegistrationResponseJSONSchema,
  /** Solid Ten Sign (AUD-C10): an authenticator or backup code, required when 2FA is on. */
  twoFactorCode: z.string().max(64).optional(),
});

export const ZCreatePasskeyResponseSchema = z.void();

export type TCreatePasskeyRequest = z.infer<typeof ZCreatePasskeyRequestSchema>;
export type TCreatePasskeyResponse = z.infer<typeof ZCreatePasskeyResponseSchema>;
