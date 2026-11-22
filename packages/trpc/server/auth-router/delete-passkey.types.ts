import { z } from 'zod';

export const ZDeletePasskeyRequestSchema = z.object({
  passkeyId: z.string().trim().min(1),
  // Solid Ten Sign (AUD-C10 follow-up): needed when the account has 2FA on.
  twoFactorCode: z.string().max(64).optional(),
});

export const ZDeletePasskeyResponseSchema = z.void();

export type TDeletePasskeyRequest = z.infer<typeof ZDeletePasskeyRequestSchema>;
export type TDeletePasskeyResponse = z.infer<typeof ZDeletePasskeyResponseSchema>;
