import { z } from 'zod';

export const RETENTION_MIN_DAYS = 1;
export const RETENTION_MAX_DAYS = 36500;

/**
 * A retention rule as stored on organisation and team settings.
 * Kept free of Prisma imports: the generated Prisma zod schemas import it.
 */
export const ZRetentionSettingsSchema = z.object({
  enabled: z.boolean(),
  action: z.enum(['SOFT_DELETE', 'PURGE']),
  /**
   * Days after the document finished (completed, rejected or cancelled).
   */
  days: z.number().int().min(RETENTION_MIN_DAYS).max(RETENTION_MAX_DAYS),
  includeRejected: z.boolean(),
  includeCancelled: z.boolean(),
});

export type TRetentionSettings = z.infer<typeof ZRetentionSettingsSchema>;
