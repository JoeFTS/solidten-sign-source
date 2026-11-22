import { ZRetentionSettingsSchema } from '@documenso/lib/utils/retention';
import { z } from 'zod';

export const ZLifecycleSettingsScopeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('organisation'), organisationId: z.string() }),
  z.object({ type: z.literal('team'), teamId: z.number() }),
]);

const ZLifecycleSettingsValuesSchema = z.object({
  allowSenderReassign: z.boolean().nullable(),
  allowSignerReassign: z.boolean().nullable(),
  allowInPersonSigning: z.boolean().nullable(),
  commentsEnabled: z.boolean().nullable(),
  commentsSharedThread: z.boolean().nullable(),
  retentionSettings: ZRetentionSettingsSchema.nullable(),
});

export const ZGetLifecycleSettingsRequestSchema = z.object({
  scope: ZLifecycleSettingsScopeSchema,
});

export const ZGetLifecycleSettingsResponseSchema = z.object({
  organisation: ZLifecycleSettingsValuesSchema,
  team: ZLifecycleSettingsValuesSchema.nullable(),
});

export const ZUpdateLifecycleSettingsRequestSchema = z.object({
  scope: ZLifecycleSettingsScopeSchema,
  data: ZLifecycleSettingsValuesSchema.partial(),
});

export const ZPreviewRetentionRequestSchema = z.object({
  scope: ZLifecycleSettingsScopeSchema,
  settings: ZRetentionSettingsSchema,
});

export const ZPreviewRetentionResponseSchema = z.object({
  count: z.number(),
});

export type TLifecycleSettingsScope = z.infer<typeof ZLifecycleSettingsScopeSchema>;
