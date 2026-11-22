import {
  findSettingsIdForManager,
  getLifecycleSettings,
  updateLifecycleSettings,
} from '@documenso/lib/server-only/lifecycle-settings/lifecycle-settings';
import { countRetentionMatches } from '@documenso/lib/server-only/retention/preview-retention';

import { ZGenericSuccessResponse, ZSuccessResponseSchema } from '../schema';
import { authenticatedProcedure } from '../trpc';
import {
  ZGetLifecycleSettingsRequestSchema,
  ZGetLifecycleSettingsResponseSchema,
  ZPreviewRetentionRequestSchema,
  ZPreviewRetentionResponseSchema,
  ZUpdateLifecycleSettingsRequestSchema,
} from './lifecycle-settings.types';

export const getLifecycleSettingsRoute = authenticatedProcedure
  .input(ZGetLifecycleSettingsRequestSchema)
  .output(ZGetLifecycleSettingsResponseSchema)
  .query(async ({ input, ctx }) => {
    return await getLifecycleSettings({ scope: input.scope, userId: ctx.user.id });
  });

export const updateLifecycleSettingsRoute = authenticatedProcedure
  .input(ZUpdateLifecycleSettingsRequestSchema)
  .output(ZSuccessResponseSchema)
  .mutation(async ({ input, ctx }) => {
    ctx.logger.info({
      input: {
        scope: input.scope,
      },
    });

    await updateLifecycleSettings({
      scope: input.scope,
      userId: ctx.user.id,
      data: input.data,
      requestMetadata: ctx.metadata.requestMetadata,
    });

    return ZGenericSuccessResponse;
  });

export const previewRetentionRoute = authenticatedProcedure
  .input(ZPreviewRetentionRequestSchema)
  .output(ZPreviewRetentionResponseSchema)
  .query(async ({ input, ctx }) => {
    // Only managers of the scope may see counts for it.
    await findSettingsIdForManager({ scope: input.scope, userId: ctx.user.id });

    const count = await countRetentionMatches({ scope: input.scope, settings: input.settings, userId: ctx.user.id });

    return { count };
  });
