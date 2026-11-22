import { prisma } from '@documenso/prisma';
import { DocumentStatus, EnvelopeScheduledSendStatus, EnvelopeType } from '@prisma/client';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../types/document-audit-logs';
import { isTspEnvelope } from '../../types/signature-level';
import type { ApiRequestMetadata } from '../../universal/extract-request-metadata';
import { createDocumentAuditLogData } from '../../utils/document-audit-logs';
import { getRecipientsWithMissingFields } from '../../utils/recipients';
import { resolveScheduledSendTime, type ScheduledSendTimeError } from '../../utils/scheduled-send';
import { getEnvelopeWhereInput } from '../envelope/get-envelope-by-id';

export type ScheduleEnvelopeSendOptions = {
  envelopeId: string;
  userId: number;
  teamId: number;
  localDateTime: string;
  timezone: string;
  requestMetadata: ApiRequestMetadata;
};

const TIME_ERROR_MESSAGES: Record<ScheduledSendTimeError, string> = {
  INVALID_TIMEZONE: 'The timezone is not valid.',
  INVALID_DATE: 'The date and time are not valid.',
  NONEXISTENT_LOCAL_TIME:
    'This time does not exist in the chosen timezone because the clocks change. Pick another time.',
  IN_PAST: 'Pick a time at least one minute from now.',
  TOO_FAR: 'Pick a time within the next year.',
};

/**
 * Find a draft the user may send and check it can be scheduled at all.
 * Shared by schedule and unschedule so both apply the same access rules as sendDocument.
 */
export const getSchedulableEnvelope = async ({
  envelopeId,
  userId,
  teamId,
}: {
  envelopeId: string;
  userId: number;
  teamId: number;
}) => {
  const { envelopeWhereInput } = await getEnvelopeWhereInput({
    id: { type: 'envelopeId', id: envelopeId },
    type: EnvelopeType.DOCUMENT,
    userId,
    teamId,
  });

  const envelope = await prisma.envelope.findFirst({
    where: envelopeWhereInput,
    include: {
      recipients: true,
      fields: true,
      scheduledSend: true,
    },
  });

  if (!envelope) {
    throw new AppError(AppErrorCode.NOT_FOUND, {
      message: 'Document not found',
    });
  }

  return envelope;
};

/**
 * Every check scheduling makes, with no writes. Solid Ten Sign (S-L6): the route runs this
 * before it saves the email settings that come with the request, so a refused schedule
 * changes nothing.
 */
export const validateEnvelopeScheduledSend = async ({
  envelopeId,
  userId,
  teamId,
  localDateTime,
  timezone,
}: Omit<ScheduleEnvelopeSendOptions, 'requestMetadata'>) => {
  const envelope = await getSchedulableEnvelope({ envelopeId, userId, teamId });

  if (envelope.internalVersion !== 2) {
    throw new AppError(AppErrorCode.ENVELOPE_LEGACY, {
      message: 'Scheduled sending is only available for documents made in the current editor.',
    });
  }

  if (isTspEnvelope(envelope)) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Scheduled sending is not available for qualified-signature documents.',
    });
  }

  if (envelope.status !== DocumentStatus.DRAFT) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Only draft documents can be scheduled.',
    });
  }

  if (envelope.recipients.length === 0) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Add at least one recipient before you schedule this document.',
    });
  }

  if (getRecipientsWithMissingFields(envelope.recipients, envelope.fields).length > 0) {
    throw new AppError(AppErrorCode.MISSING_SIGNATURE_FIELD, {
      message: 'Every signer needs a signature field before you schedule this document.',
    });
  }

  const resolved = resolveScheduledSendTime({ localDateTime, timezone, now: new Date() });

  if (!resolved.ok) {
    throw new AppError('INVALID_SCHEDULED_TIME', {
      message: TIME_ERROR_MESSAGES[resolved.error],
      statusCode: 400,
    });
  }

  return { envelope, scheduledAt: resolved.scheduledAt };
};

export const scheduleEnvelopeSend = async ({
  envelopeId,
  userId,
  teamId,
  localDateTime,
  timezone,
  requestMetadata,
}: ScheduleEnvelopeSendOptions) => {
  const { envelope, scheduledAt } = await validateEnvelopeScheduledSend({
    envelopeId,
    userId,
    teamId,
    localDateTime,
    timezone,
  });

  return await prisma.$transaction(async (tx) => {
    const existing = await tx.envelopeScheduledSend.findUnique({
      where: { envelopeId: envelope.id },
    });

    if (existing?.status === EnvelopeScheduledSendStatus.SENDING) {
      throw new AppError('SCHEDULED_SEND_IN_PROGRESS', {
        message: 'This document is being sent now.',
        statusCode: 409,
      });
    }

    // Conditional write so a sweep that claimed the row after the read above wins.
    const scheduledSend = existing
      ? await tx.envelopeScheduledSend
          .update({
            where: {
              id: existing.id,
              status: { in: [EnvelopeScheduledSendStatus.SCHEDULED, EnvelopeScheduledSendStatus.FAILED] },
            },
            data: {
              scheduledAt,
              timezone,
              userId,
              status: EnvelopeScheduledSendStatus.SCHEDULED,
              claimedAt: null,
              attempts: 0,
              lastError: null,
              sentAt: null,
            },
          })
          .catch(() => {
            throw new AppError('SCHEDULED_SEND_IN_PROGRESS', {
              message: 'This document is being sent now.',
              statusCode: 409,
            });
          })
      : await tx.envelopeScheduledSend.create({
          data: {
            envelopeId: envelope.id,
            scheduledAt,
            timezone,
            userId,
          },
        });

    await tx.documentAuditLog.create({
      data: createDocumentAuditLogData({
        type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_SEND_SCHEDULED,
        envelopeId: envelope.id,
        metadata: requestMetadata,
        data: {
          scheduledAt: scheduledAt.toISOString(),
          timezone,
          previousScheduledAt:
            existing?.status === EnvelopeScheduledSendStatus.SCHEDULED ? existing.scheduledAt.toISOString() : null,
        },
      }),
    });

    return scheduledSend;
  });
};
