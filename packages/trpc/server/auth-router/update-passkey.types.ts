import { ZNameSchema } from '@documenso/lib/types/name';
import { z } from 'zod';

export const ZUpdatePasskeyRequestSchema = z.object({
  passkeyId: z.string().trim().min(1),
  name: ZNameSchema,
  // Solid Ten Sign (AUD-C10 follow-up): needed when the account has 2FA on.
  twoFactorCode: z.string().max(64).optional(),
});

export const ZUpdatePasskeyResponseSchema = z.void();

export type TUpdatePasskeyRequest = z.infer<typeof ZUpdatePasskeyRequestSchema>;
export type TUpdatePasskeyResponse = z.infer<typeof ZUpdatePasskeyResponseSchema>;
