import { requestPublicFormCode, verifyPublicFormCode } from '@documenso/lib/server-only/public-form/public-form-code';
import {
  exportPublicFormResponsesCsv,
  findPublicFormResponses,
} from '@documenso/lib/server-only/public-form/public-form-responses';
import {
  getPublicFormSettings,
  setPublicFormClosed,
  updatePublicFormSettings,
} from '@documenso/lib/server-only/public-form/public-form-settings';

import { authenticatedProcedure, procedure, router } from '../trpc';
import {
  ZExportPublicFormResponsesRequestSchema,
  ZFindPublicFormResponsesRequestSchema,
  ZGetPublicFormSettingsRequestSchema,
  ZRequestPublicFormCodeRequestSchema,
  ZSetPublicFormClosedRequestSchema,
  ZUpdatePublicFormSettingsRequestSchema,
  ZVerifyPublicFormCodeRequestSchema,
  ZVerifyPublicFormCodeResponseSchema,
} from './schema';

export const publicFormRouter = router({
  getSettings: authenticatedProcedure.input(ZGetPublicFormSettingsRequestSchema).query(async ({ input, ctx }) => {
    return await getPublicFormSettings({ userId: ctx.user.id, teamId: ctx.teamId, envelopeId: input.envelopeId });
  }),

  updateSettings: authenticatedProcedure
    .input(ZUpdatePublicFormSettingsRequestSchema)
    .mutation(async ({ input, ctx }) => {
      const { envelopeId, data } = input;

      await updatePublicFormSettings({ userId: ctx.user.id, teamId: ctx.teamId, envelopeId, data });
    }),

  setClosed: authenticatedProcedure.input(ZSetPublicFormClosedRequestSchema).mutation(async ({ input, ctx }) => {
    const { envelopeId, closed } = input;

    await setPublicFormClosed({ userId: ctx.user.id, teamId: ctx.teamId, envelopeId, closed });
  }),

  findResponses: authenticatedProcedure.input(ZFindPublicFormResponsesRequestSchema).query(async ({ input, ctx }) => {
    return await findPublicFormResponses({ userId: ctx.user.id, teamId: ctx.teamId, ...input });
  }),

  exportResponses: authenticatedProcedure
    .input(ZExportPublicFormResponsesRequestSchema)
    .mutation(async ({ input, ctx }) => {
      return await exportPublicFormResponsesCsv({ userId: ctx.user.id, teamId: ctx.teamId, ...input });
    }),

  requestCode: procedure.input(ZRequestPublicFormCodeRequestSchema).mutation(async ({ input, ctx }) => {
    await requestPublicFormCode({ ...input, requestMetadata: ctx.metadata.requestMetadata });
  }),

  verifyCode: procedure
    .input(ZVerifyPublicFormCodeRequestSchema)
    .output(ZVerifyPublicFormCodeResponseSchema)
    .mutation(async ({ input, ctx }) => {
      return await verifyPublicFormCode({ ...input, requestMetadata: ctx.metadata.requestMetadata });
    }),
});
