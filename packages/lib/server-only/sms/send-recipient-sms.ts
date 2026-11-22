import { prisma } from '@documenso/prisma';
import { Prisma, type Recipient } from '@prisma/client';

import type { TSmsFailureReason, TSmsPurpose } from '../../types/sms-audit-logs';
import type { RequestMetadata } from '../../universal/extract-request-metadata';
import { createDocumentAuditLogData } from '../../utils/document-audit-logs';
import { logger } from '../../utils/logger';
import { buildSmsBody } from '../../utils/sms/message';
import { maskPhoneNumber } from '../../utils/sms/phone';
import { recordServerCapReached } from '../rate-limit/server-cap-alerts';
import { getSmsProvider } from './sms-config';
import { exceedsSmsLimits, getSmsDailyCap, isSmsCountryAllowed } from './sms-limits';

// Sends per team per hour. Protects the account balance and the sender's 10DLC throughput.
export const SMS_TEAM_HOURLY_LIMIT = 200;

// Sends per recipient per day across the first request, reminders and resends.
export const SMS_RECIPIENT_DAILY_LIMIT = 5;

export type TSendRecipientSmsOptions = {
  recipient: Pick<Recipient, 'id' | 'email' | 'name' | 'role'>;
  envelopeId: string;
  teamId: number;
  purpose: TSmsPurpose;
  /**
   * Same key = same text. A job retry or a second job for the same recipient and purpose
   * reuses the key, so the text goes at most once.
   */
  idempotencyKey: string;
  title: string;
  render: (title: string) => string;
  user?: { id?: number | null; email?: string | null; name?: string | null } | null;
  requestMetadata?: RequestMetadata;
};

export type TSendRecipientSmsResult =
  | { status: 'SENT' }
  | { status: 'DUPLICATE'; isDelivered: boolean }
  | { status: 'SKIPPED'; reason: 'NO_PHONE' | 'OPTED_OUT' }
  | { status: 'FAILED'; reason: TSmsFailureReason };

const isUniqueViolation = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

export const sendRecipientSms = async (options: TSendRecipientSmsOptions): Promise<TSendRecipientSmsResult> => {
  const { recipient, envelopeId, teamId, purpose, idempotencyKey, user, requestMetadata } = options;

  const provider = getSmsProvider();

  if (!provider) {
    return { status: 'FAILED', reason: 'PROVIDER_ERROR' };
  }

  const channel = await prisma.recipientSmsChannel.findUnique({
    where: { recipientId: recipient.id },
  });

  const auditBase = {
    recipientEmail: recipient.email,
    recipientName: recipient.name,
    recipientId: recipient.id,
    recipientRole: recipient.role,
    phoneNumberMasked: channel ? maskPhoneNumber(channel.phoneE164) : null,
    purpose,
  };

  const writeFailedAudit = async (reason: TSmsFailureReason, providerErrorCode: string | null = null) => {
    await prisma.documentAuditLog.create({
      data: createDocumentAuditLogData({
        type: 'SMS_FAILED',
        envelopeId,
        user,
        requestMetadata,
        data: { ...auditBase, reason, providerErrorCode },
      }),
    });
  };

  if (!channel) {
    await writeFailedAudit('NO_PHONE');

    return { status: 'SKIPPED', reason: 'NO_PHONE' };
  }

  const optOut = channel.optedOutAt
    ? true
    : await prisma.smsOptOut.findUnique({ where: { phoneE164: channel.phoneE164 } }).then(Boolean);

  if (optOut) {
    await prisma.recipientSmsChannel.update({
      where: { id: channel.id },
      data: { status: 'OPTED_OUT', optedOutAt: channel.optedOutAt ?? new Date() },
    });

    await writeFailedAudit('OPTED_OUT');

    return { status: 'SKIPPED', reason: 'OPTED_OUT' };
  }

  const built = buildSmsBody({ render: options.render, title: options.title });

  // Solid Ten Sign (S-M4): a number stored before the country rule, or with a rule since narrowed.
  const isCountryAllowed = isSmsCountryAllowed(channel.phoneE164);

  const claim = await claimSmsMessage({
    idempotencyKey,
    recipientId: recipient.id,
    envelopeId,
    teamId,
    purpose,
    toE164: channel.phoneE164,
    body: built.success ? built.body : '',
    segments: built.success ? built.segments : 0,
    provider: provider.name,
  });

  if (!claim) {
    const existing = await prisma.smsMessage.findUnique({
      where: { idempotencyKey },
      select: { status: true },
    });

    return { status: 'DUPLICATE', isDelivered: existing?.status === 'SENT' };
  }

  const markFailed = async (
    reason: TSmsFailureReason,
    errorCode: string | null,
    errorMessage: string,
    isRetryable: boolean,
  ) => {
    await prisma.$transaction([
      prisma.smsMessage.update({
        where: { id: claim.id },
        data: { status: 'FAILED', errorCode: errorCode ?? reason, errorMessage, isRetryable },
      }),
      prisma.recipientSmsChannel.update({
        where: { id: channel.id },
        data: { status: 'FAILED', lastError: reason },
      }),
    ]);

    await writeFailedAudit(reason, errorCode);

    return { status: 'FAILED', reason } as const;
  };

  if (!built.success) {
    return await markFailed('MESSAGE_TOO_LONG', null, 'The text does not fit in the segment limit', false);
  }

  if (!isCountryAllowed) {
    return await markFailed('INVALID_NUMBER', 'COUNTRY_NOT_ALLOWED', 'Texts to this country are not allowed', false);
  }

  const isRateLimited = await isOverSmsRateLimit({ teamId, recipientId: recipient.id, excludeId: claim.id });

  if (isRateLimited) {
    return await markFailed('RATE_LIMITED', null, 'Text message rate limit reached', false);
  }

  const result = await provider.send({ toE164: channel.phoneE164, body: built.body }).catch(
    (err: unknown) =>
      ({
        success: false,
        reason: 'PROVIDER_ERROR',
        errorCode: 'EXCEPTION',
        message: err instanceof Error ? err.message : 'Unknown error',
        isRetryable: true,
      }) as const,
  );

  if (!result.success) {
    logger.warn({
      msg: 'Text message failed',
      envelopeId,
      recipientId: recipient.id,
      reason: result.reason,
      errorCode: result.errorCode,
    });

    if (result.reason === 'OPTED_OUT') {
      await prisma.$transaction([
        prisma.smsOptOut.upsert({
          where: { phoneE164: channel.phoneE164 },
          create: { phoneE164: channel.phoneE164, source: provider.name },
          update: {},
        }),
        prisma.smsMessage.update({
          where: { id: claim.id },
          data: { status: 'FAILED', errorCode: result.errorCode, errorMessage: result.message, isRetryable: false },
        }),
        prisma.recipientSmsChannel.update({
          where: { id: channel.id },
          data: { status: 'OPTED_OUT', optedOutAt: new Date(), lastError: 'OPTED_OUT' },
        }),
      ]);

      await writeFailedAudit('OPTED_OUT', result.errorCode);

      return { status: 'SKIPPED', reason: 'OPTED_OUT' };
    }

    return await markFailed(result.reason, result.errorCode, result.message, result.isRetryable);
  }

  const sentAt = new Date();

  await prisma.$transaction([
    prisma.smsMessage.update({
      where: { id: claim.id },
      data: { status: 'SENT', providerMessageId: result.providerMessageId, errorCode: null, errorMessage: null },
    }),
    prisma.recipientSmsChannel.update({
      where: { id: channel.id },
      data: { status: 'SENT', sentAt, lastError: null },
    }),
  ]);

  await prisma.documentAuditLog.create({
    data: createDocumentAuditLogData({
      type: 'SMS_SENT',
      envelopeId,
      user,
      requestMetadata,
      data: {
        ...auditBase,
        provider: provider.name,
        providerMessageId: result.providerMessageId,
        segments: built.segments,
      },
    }),
  });

  return { status: 'SENT' };
};

type TClaimSmsMessageOptions = {
  idempotencyKey: string;
  recipientId: number;
  envelopeId: string;
  teamId: number;
  purpose: TSmsPurpose;
  toE164: string;
  body: string;
  segments: number;
  provider: string;
};

/**
 * Claim the right to send the text for this key. Returns null when another attempt already
 * sent it, is sending it now, or failed for good. A retryable failure can be claimed again.
 *
 * A crash between the provider call and the status update leaves the row PENDING; it is never
 * claimed again. We accept a possibly missed text over a possibly doubled one.
 */
const claimSmsMessage = async (data: TClaimSmsMessageOptions) => {
  try {
    return await prisma.smsMessage.create({
      data: { ...data, status: 'PENDING' },
      select: { id: true },
    });
  } catch (err) {
    if (!isUniqueViolation(err)) {
      throw err;
    }
  }

  const reclaimed = await prisma.smsMessage.updateMany({
    where: { idempotencyKey: data.idempotencyKey, status: 'FAILED', isRetryable: true },
    data: { status: 'PENDING', toE164: data.toE164, body: data.body, segments: data.segments },
  });

  if (reclaimed.count === 0) {
    return null;
  }

  return await prisma.smsMessage.findUniqueOrThrow({
    where: { idempotencyKey: data.idempotencyKey },
    select: { id: true },
  });
};

const isOverSmsRateLimit = async ({
  teamId,
  recipientId,
  excludeId,
}: {
  teamId: number;
  recipientId: number;
  excludeId: string;
}) => {
  const now = Date.now();

  const [teamCount, recipientCount, serverCount] = await Promise.all([
    prisma.smsMessage.count({
      where: {
        teamId,
        id: { not: excludeId },
        status: { in: ['SENT', 'PENDING'] },
        createdAt: { gte: new Date(now - 60 * 60 * 1000) },
      },
    }),
    prisma.smsMessage.count({
      where: {
        recipientId,
        id: { not: excludeId },
        status: { in: ['SENT', 'PENDING'] },
        createdAt: { gte: new Date(now - 24 * 60 * 60 * 1000) },
      },
    }),
    // Solid Ten Sign (S-M4): a ceiling for the whole server.
    prisma.smsMessage.count({
      where: {
        id: { not: excludeId },
        status: { in: ['SENT', 'PENDING'] },
        createdAt: { gte: new Date(now - 24 * 60 * 60 * 1000) },
      },
    }),
  ]);

  // Solid Ten Sign: staff hear when the whole server stops texting for the day.
  if (serverCount >= getSmsDailyCap()) {
    await recordServerCapReached('SMS');
  }

  return exceedsSmsLimits(
    { team: teamCount, recipient: recipientCount, server: serverCount },
    { teamHourly: SMS_TEAM_HOURLY_LIMIT, recipientDaily: SMS_RECIPIENT_DAILY_LIMIT, serverDaily: getSmsDailyCap() },
  );
};
