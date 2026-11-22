import { getTeamSmsSettings } from '@documenso/lib/server-only/sms/get-team-sms-settings';
import { canSeeFullPhoneNumbers, maskSmsStatusPhones } from '@documenso/lib/server-only/sms/mask-sms-status-for-viewer';
import { getEnvelopeSmsStatus, setRecipientPhone } from '@documenso/lib/server-only/sms/recipient-sms-channel';
import {
  getOrganisationSmsSettings,
  updateOrganisationSmsSettings,
  updateTeamSmsSettings,
} from '@documenso/lib/server-only/sms/update-sms-settings';
import { getTeamById } from '@documenso/lib/server-only/team/get-team';

import { authenticatedProcedure, router } from '../trpc';
import {
  getEnvelopeSmsStatusMeta,
  setRecipientPhoneMeta,
  ZGetEnvelopeSmsStatusRequestSchema,
  ZGetEnvelopeSmsStatusResponseSchema,
  ZGetOrganisationSmsSettingsRequestSchema,
  ZGetTeamSmsSettingsRequestSchema,
  ZSetRecipientPhoneRequestSchema,
  ZSetRecipientPhoneResponseSchema,
  ZUpdateOrganisationSmsSettingsRequestSchema,
  ZUpdateTeamSmsSettingsRequestSchema,
} from './schema';

export const smsRouter = router({
  getTeamSettings: authenticatedProcedure.input(ZGetTeamSmsSettingsRequestSchema).query(async ({ input, ctx }) => {
    // Throws when the user is not a member of the team.
    await getTeamById({ teamId: input.teamId, userId: ctx.user.id });

    return await getTeamSmsSettings({ teamId: input.teamId });
  }),

  getOrganisationSettings: authenticatedProcedure
    .input(ZGetOrganisationSmsSettingsRequestSchema)
    .query(async ({ input, ctx }) => {
      return await getOrganisationSmsSettings({ userId: ctx.user.id, organisationId: input.organisationId });
    }),

  updateOrganisationSettings: authenticatedProcedure
    .input(ZUpdateOrganisationSmsSettingsRequestSchema)
    .mutation(async ({ input, ctx }) => {
      ctx.logger.info({ input: { organisationId: input.organisationId } });

      await updateOrganisationSmsSettings({ userId: ctx.user.id, ...input });
    }),

  updateTeamSettings: authenticatedProcedure
    .input(ZUpdateTeamSmsSettingsRequestSchema)
    .mutation(async ({ input, ctx }) => {
      ctx.logger.info({ input: { teamId: input.teamId } });

      await updateTeamSmsSettings({ userId: ctx.user.id, ...input });
    }),

  setRecipientPhone: authenticatedProcedure
    .meta(setRecipientPhoneMeta)
    .input(ZSetRecipientPhoneRequestSchema)
    .output(ZSetRecipientPhoneResponseSchema)
    .mutation(async ({ input, ctx }) => {
      const { envelopeId, recipientId, phoneNumber } = input;

      ctx.logger.info({ input: { envelopeId, recipientId } });

      return await setRecipientPhone({
        userId: ctx.user.id,
        teamId: ctx.teamId,
        envelopeId,
        recipientId,
        phoneNumber,
        metadata: ctx.metadata,
      });
    }),

  getEnvelopeStatus: authenticatedProcedure
    .meta(getEnvelopeSmsStatusMeta)
    .input(ZGetEnvelopeSmsStatusRequestSchema)
    .output(ZGetEnvelopeSmsStatusResponseSchema)
    .query(async ({ input, ctx }) => {
      const status = await getEnvelopeSmsStatus({
        userId: ctx.user.id,
        teamId: ctx.teamId,
        envelopeId: input.envelopeId,
      });

      // Solid Ten Sign: plain members see masked numbers.
      if (await canSeeFullPhoneNumbers({ envelopeId: input.envelopeId, userId: ctx.user.id })) {
        return status;
      }

      return maskSmsStatusPhones(status);
    }),
});
