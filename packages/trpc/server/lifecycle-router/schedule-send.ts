import { updateDocumentMeta } from '@documenso/lib/server-only/document-meta/upsert-document-meta';
import {
  scheduleEnvelopeSend,
  validateEnvelopeScheduledSend,
} from '@documenso/lib/server-only/scheduled-send/schedule-envelope-send';

import { authenticatedProcedure } from '../trpc';
import { scheduleSendMeta, ZScheduleSendRequestSchema, ZScheduleSendResponseSchema } from './schedule-send.types';

export const scheduleSendRoute = authenticatedProcedure
  .meta(scheduleSendMeta)
  .input(ZScheduleSendRequestSchema)
  .output(ZScheduleSendResponseSchema)
  .mutation(async ({ input, ctx }) => {
    const { teamId } = ctx;
    const { envelopeId, localDateTime, timezone, meta = {} } = input;

    ctx.logger.info({
      input: {
        envelopeId,
      },
    });

    // Solid Ten Sign (S-L6): refuse before writing anything.
    await validateEnvelopeScheduledSend({ envelopeId, userId: ctx.user.id, teamId, localDateTime, timezone });

    if (Object.values(meta).length > 0) {
      await updateDocumentMeta({
        userId: ctx.user.id,
        teamId,
        id: {
          type: 'envelopeId',
          id: envelopeId,
        },
        subject: meta.subject,
        message: meta.message,
        dateFormat: meta.dateFormat,
        timezone: meta.timezone,
        redirectUrl: meta.redirectUrl,
        distributionMethod: meta.distributionMethod,
        emailSettings: meta.emailSettings ?? undefined,
        language: meta.language,
        emailId: meta.emailId,
        emailReplyTo: meta.emailReplyTo,
        requestMetadata: ctx.metadata,
      });
    }

    const scheduledSend = await scheduleEnvelopeSend({
      envelopeId,
      userId: ctx.user.id,
      teamId,
      localDateTime,
      timezone,
      requestMetadata: ctx.metadata,
    });

    return {
      envelopeId: scheduledSend.envelopeId,
      scheduledAt: scheduledSend.scheduledAt,
      timezone: scheduledSend.timezone,
    };
  });
