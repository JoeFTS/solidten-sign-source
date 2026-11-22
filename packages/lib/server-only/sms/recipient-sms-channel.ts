import { prisma } from '@documenso/prisma';
import { DocumentStatus, RecipientRole, SigningStatus } from '@prisma/client';

import { AppError, AppErrorCode } from '../../errors/app-error';
import type { ApiRequestMetadata } from '../../universal/extract-request-metadata';
import { normalizePhoneNumber } from '../../utils/sms/phone';
import { getEnvelopeWhereInput } from '../envelope/get-envelope-by-id';
import { handoverRecipientPhone } from '../recipient-reassign/handover-recipient-phone';
import { resolveHandoverPhone } from '../recipient-reassign/recipient-handover';
import { isSmsSupportedEnvelope } from './sms-availability';
import { isSmsProviderConfigured } from './sms-config';
import { assertSmsCountryAllowed } from './sms-limits';

type TAccessOptions = {
  userId: number;
  teamId: number;
  envelopeId: string;
};

const getAccessibleEnvelope = async ({ userId, teamId, envelopeId }: TAccessOptions) => {
  const { envelopeWhereInput } = await getEnvelopeWhereInput({
    id: { type: 'envelopeId', id: envelopeId },
    userId,
    teamId,
    type: null,
  });

  const envelope = await prisma.envelope.findFirst({
    where: envelopeWhereInput,
    select: {
      id: true,
      status: true,
      teamId: true,
      internalVersion: true,
      signatureLevel: true,
      recipients: {
        select: {
          id: true,
          role: true,
          signingStatus: true,
          smsChannel: true,
        },
      },
    },
  });

  if (!envelope) {
    throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Envelope not found' });
  }

  return envelope;
};

export type TSetRecipientPhoneOptions = TAccessOptions & {
  recipientId: number;
  /** Null or empty removes the number. */
  phoneNumber: string | null;
  /** Solid Ten: for the audit entry when a sent recipient's number changes. */
  metadata?: ApiRequestMetadata;
};

export const setRecipientPhone = async ({
  phoneNumber,
  recipientId,
  metadata,
  ...access
}: TSetRecipientPhoneOptions) => {
  if (!isSmsProviderConfigured()) {
    throw new AppError(AppErrorCode.NOT_SETUP, { message: 'Text messages are not set up on this server.' });
  }

  const envelope = await getAccessibleEnvelope(access);

  if (!isSmsSupportedEnvelope(envelope)) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Text messages are only available for new envelopes with simple electronic signatures.',
    });
  }

  if (envelope.status !== DocumentStatus.DRAFT && envelope.status !== DocumentStatus.PENDING) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, { message: 'This envelope can no longer be changed.' });
  }

  const recipient = envelope.recipients.find((r) => r.id === recipientId);

  if (!recipient) {
    throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Recipient not found' });
  }

  if (recipient.role === RecipientRole.CC) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, { message: 'CC recipients do not receive signing links.' });
  }

  if (recipient.signingStatus !== SigningStatus.NOT_SIGNED) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, { message: 'This recipient has already completed their part.' });
  }

  // Solid Ten: once sent, a different number (or none) means the link must move too.
  if (envelope.status === DocumentStatus.PENDING && recipient.smsChannel) {
    const newPhone = await resolveHandoverPhone({ phoneNumber, envelope });

    if (newPhone?.e164 !== recipient.smsChannel.phoneE164) {
      await handoverRecipientPhone({ envelopeId: envelope.id, recipientId, newPhone, metadata });

      return { phoneE164: newPhone?.e164 ?? null };
    }
  }

  if (!phoneNumber || phoneNumber.trim() === '') {
    await prisma.recipientSmsChannel.deleteMany({ where: { recipientId } });

    return { phoneE164: null };
  }

  const normalized = normalizePhoneNumber(phoneNumber);

  if (!normalized.success) {
    throw new AppError(AppErrorCode.INVALID_BODY, {
      message: 'Enter a mobile number with country code, for example +1 555 123 4567.',
    });
  }

  // Solid Ten Sign (S-M4): only numbers in the allowed countries (default +1).
  assertSmsCountryAllowed(normalized.e164);

  const optOut = await prisma.smsOptOut.findUnique({ where: { phoneE164: normalized.e164 } });

  const isSameNumber = recipient.smsChannel?.phoneE164 === normalized.e164;

  await prisma.recipientSmsChannel.upsert({
    where: { recipientId },
    create: {
      recipientId,
      phoneE164: normalized.e164,
      status: optOut ? 'OPTED_OUT' : 'NOT_SENT',
      optedOutAt: optOut?.createdAt ?? null,
    },
    update: isSameNumber
      ? {}
      : {
          phoneE164: normalized.e164,
          status: optOut ? 'OPTED_OUT' : 'NOT_SENT',
          optedOutAt: optOut?.createdAt ?? null,
          lastError: null,
          sentAt: null,
        },
  });

  return { phoneE164: normalized.e164 };
};

export const getEnvelopeSmsStatus = async (access: TAccessOptions) => {
  const envelope = await getAccessibleEnvelope(access);

  const messages = await prisma.smsMessage.findMany({
    where: { envelopeId: envelope.id },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: {
      id: true,
      recipientId: true,
      purpose: true,
      status: true,
      errorCode: true,
      createdAt: true,
    },
  });

  return {
    isSupported: isSmsSupportedEnvelope(envelope),
    recipients: envelope.recipients.map((recipient) => ({
      recipientId: recipient.id,
      phoneE164: recipient.smsChannel?.phoneE164 ?? null,
      status: recipient.smsChannel?.status ?? null,
      lastError: recipient.smsChannel?.lastError ?? null,
      sentAt: recipient.smsChannel?.sentAt ?? null,
      optedOutAt: recipient.smsChannel?.optedOutAt ?? null,
    })),
    messages,
  };
};
