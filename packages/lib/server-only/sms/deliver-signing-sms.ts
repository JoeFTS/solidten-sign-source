import { prisma } from '@documenso/prisma';
import {
  DocumentDistributionMethod,
  type DocumentMeta,
  type Recipient,
  RecipientRole,
  SendStatus,
} from '@prisma/client';

import { getI18nInstance } from '../../client-only/providers/i18n-server';
import { RECIPIENT_ROLES_DESCRIPTION } from '../../constants/recipient-roles';
import type { TSmsPurpose } from '../../types/sms-audit-logs';
import type { RequestMetadata } from '../../universal/extract-request-metadata';
import { formatSigningLink } from '../../utils/recipients';
import { isSmsChannelRequested, resolveRecipientChannels } from '../../utils/sms/channels';
import { createSigningSmsRenderer } from '../../utils/sms/message';
import { updateRecipientNextReminder } from '../recipient/update-recipient-next-reminder';
import { getTeamSmsSettings } from './get-team-sms-settings';
import { sendRecipientSms, type TSendRecipientSmsResult } from './send-recipient-sms';
import { buildSmsIdempotencyKey, isSmsSupportedEnvelope } from './sms-availability';
import { isSmsProviderConfigured } from './sms-config';

export type TDeliverSigningSmsOptions = {
  envelope: {
    id: string;
    teamId: number;
    title: string;
    internalVersion: number;
    signatureLevel: string;
    documentMeta: Pick<DocumentMeta, 'distributionMethod' | 'signingChannel' | 'language'> | null;
  };
  recipient: Pick<Recipient, 'id' | 'email' | 'name' | 'role' | 'token'>;
  purpose: TSmsPurpose;
  idempotencyKey: string;
  /** The envelope's "signing request email" setting, as the caller already computed it. */
  isSigningRequestEmailEnabled: boolean;
  user?: { id?: number | null; email?: string | null; name?: string | null } | null;
  requestMetadata?: RequestMetadata;
};

export type TDeliverSigningSmsResult = {
  /** Whether the caller should still send the email for this recipient. */
  shouldSendEmail: boolean;
  /** Whether a text carried the link (now or on an earlier attempt with the same key). */
  isSmsDelivered: boolean;
  sms: TSendRecipientSmsResult | null;
};

/**
 * The one hook every signing-link sender calls before its email code: it sends the text when the
 * envelope asks for one, and tells the caller whether the email must still go.
 */
export const deliverSigningSms = async (options: TDeliverSigningSmsOptions): Promise<TDeliverSigningSmsResult> => {
  const { envelope, recipient, purpose, idempotencyKey, isSigningRequestEmailEnabled, user, requestMetadata } = options;

  const isDistributionEmail = envelope.documentMeta?.distributionMethod !== DocumentDistributionMethod.NONE;
  const signingChannel = envelope.documentMeta?.signingChannel;

  const emailOnly = (isSmsAvailable: boolean, canTextRecipient: boolean) =>
    resolveRecipientChannels({
      isDistributionEmail,
      signingChannel,
      isSigningRequestEmailEnabled,
      isSmsAvailable,
      canTextRecipient,
    }).email;

  if (
    !isSmsSupportedEnvelope(envelope) ||
    recipient.role === RecipientRole.CC ||
    !isDistributionEmail ||
    !isSmsChannelRequested(signingChannel) ||
    !isSmsProviderConfigured()
  ) {
    return { shouldSendEmail: emailOnly(false, false), isSmsDelivered: false, sms: null };
  }

  const settings = await getTeamSmsSettings({ teamId: envelope.teamId });

  if (!settings.isEnabled) {
    return { shouldSendEmail: emailOnly(false, false), isSmsDelivered: false, sms: null };
  }

  const i18n = await getI18nInstance(envelope.documentMeta?.language);
  const actionVerb = i18n._(RECIPIENT_ROLES_DESCRIPTION[recipient.role].actionVerb).toLowerCase();

  const sms = await sendRecipientSms({
    recipient,
    envelopeId: envelope.id,
    teamId: envelope.teamId,
    purpose,
    idempotencyKey,
    title: envelope.title,
    render: createSigningSmsRenderer({
      i18n,
      purpose,
      senderLabel: settings.senderLabel,
      actionVerb,
      link: formatSigningLink(recipient.token),
    }),
    user,
    requestMetadata,
  });

  const isSmsDelivered = sms.status === 'SENT' || (sms.status === 'DUPLICATE' && sms.isDelivered);

  return {
    shouldSendEmail: emailOnly(true, isSmsDelivered),
    isSmsDelivered,
    sms,
  };
};

/**
 * Text-only delivery must leave the recipient exactly as an email would: SENT, with the
 * reminder clock started.
 */
export const markRecipientSentBySms = async ({
  recipientId,
  envelopeId,
  onlyIfNotSent = false,
}: {
  recipientId: number;
  envelopeId: string;
  onlyIfNotSent?: boolean;
}) => {
  const sentAt = new Date();

  const updated = await prisma.recipient.updateMany({
    where: { id: recipientId, ...(onlyIfNotSent ? { sendStatus: SendStatus.NOT_SENT } : {}) },
    data: { sendStatus: SendStatus.SENT, sentAt },
  });

  if (updated.count > 0 && !onlyIfNotSent) {
    await updateRecipientNextReminder({ recipientId, envelopeId, sentAt, lastReminderSentAt: null });
  }
};

export type TResendSigningSmsOptions = {
  envelope: TDeliverSigningSmsOptions['envelope'];
  recipients: TDeliverSigningSmsOptions['recipient'][];
  resentAt: Date;
  isSigningRequestEmailEnabled: boolean;
  user: TDeliverSigningSmsOptions['user'];
  requestMetadata?: RequestMetadata;
};

/**
 * Manual resend: texts the chosen recipients and returns the ids that still need the email.
 */
export const resendSigningSms = async ({
  envelope,
  recipients,
  resentAt,
  isSigningRequestEmailEnabled,
  user,
  requestMetadata,
}: TResendSigningSmsOptions) => {
  const emailRecipientIds = new Set<number>();
  let smsDeliveredCount = 0;

  for (const recipient of recipients) {
    const result = await deliverSigningSms({
      envelope,
      recipient,
      purpose: 'RESEND',
      idempotencyKey: buildSmsIdempotencyKey('RESEND', recipient, resentAt.getTime()),
      isSigningRequestEmailEnabled,
      user,
      requestMetadata,
    });

    if (result.shouldSendEmail) {
      emailRecipientIds.add(recipient.id);
    }

    if (result.isSmsDelivered) {
      smsDeliveredCount += 1;

      await markRecipientSentBySms({ recipientId: recipient.id, envelopeId: envelope.id, onlyIfNotSent: true });
    }
  }

  return { emailRecipientIds, smsDeliveredCount };
};
