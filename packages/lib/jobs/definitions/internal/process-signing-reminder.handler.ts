import DocumentReminderEmailTemplate from '@documenso/email/templates/document-reminder';
import { prisma } from '@documenso/prisma';
import { msg } from '@lingui/core/macro';
import {
  DocumentDistributionMethod,
  DocumentStatus,
  OrganisationType,
  RecipientRole,
  SendStatus,
  SigningStatus,
  WebhookTriggerEvents,
} from '@prisma/client';
import { createElement } from 'react';

import { getI18nInstance } from '../../../client-only/providers/i18n-server';
import { NEXT_PUBLIC_WEBAPP_URL } from '../../../constants/app';
import { RECIPIENT_ROLES_DESCRIPTION } from '../../../constants/recipient-roles';
import { buildEnvelopeEmailHeaders } from '../../../server-only/email/build-envelope-email-headers';
import { getEmailContext } from '../../../server-only/email/get-email-context';
import { assertOrganisationRatesAndLimits } from '../../../server-only/rate-limit/assert-organisation-rates-and-limits';
import { updateRecipientNextReminder } from '../../../server-only/recipient/update-recipient-next-reminder';
import { deliverSigningSms } from '../../../server-only/sms/deliver-signing-sms';
import { buildSmsIdempotencyKey, isSigningSmsPossible } from '../../../server-only/sms/sms-availability';
import { triggerWebhook } from '../../../server-only/webhooks/trigger/trigger-webhook';
import { DOCUMENT_AUDIT_LOG_TYPE, DOCUMENT_EMAIL_TYPE } from '../../../types/document-audit-logs';
import { extractDerivedDocumentEmailSettings } from '../../../types/document-email';
import { mapEnvelopeToWebhookDocumentPayload, ZWebhookDocumentSchema } from '../../../types/webhook-payload';
import { createDocumentAuditLogData } from '../../../utils/document-audit-logs';
import { renderCustomEmailTemplate } from '../../../utils/render-custom-email-template';
import { renderEmailWithI18N } from '../../../utils/render-email-with-i18n';
import { shouldShowNewAccountWarning } from '../../../utils/sender-trust';
import type { JobRunIO } from '../../client/_internal/job';
import { runTaskAtMostOnce } from '../../client/at-most-once-task';
import type { TProcessSigningReminderJobDefinition } from './process-signing-reminder';
import { countReminder, createCutOffReminderRecorder, readReminderCount } from './reminder-count';
import { getReminderLeaseUntil, stopReminders } from './reminder-lease';

export const run = async ({ payload, io }: { payload: TProcessSigningReminderJobDefinition; io: JobRunIO }) => {
  const { recipientId } = payload;

  // Atomically claim this reminder by setting lastReminderSentAt and moving
  // nextReminderAt forward by a lease so no other sweep picks it up. The expiration filter
  // guards against races where the expiration sweep hasn't yet flagged
  // a recipient whose deadline has already passed.
  // Solid Ten: the claim runs in a task, so a re-run of this job (recovery after a crash) keeps
  // its claim and goes on to send. The lease (not null) lets the sweep find the recipient again
  // if this job is lost for good; the reschedule at the end replaces it. The claim does not count
  // the reminder (FS2-L2): a claim cut off before its task was recorded would count a reminder
  // that was never sent. The send task below counts it.
  const claim = await io.runTask('claim-reminder', async () => {
    const claimedAt = new Date();

    const result = await prisma.recipient.updateMany({
      where: {
        id: recipientId,
        // Solid Ten: only a due reminder. A second job for the same recipient (two sweeps, or a
        // recovered duplicate) finds the lease in the future and stops.
        nextReminderAt: { lte: claimedAt },
        signingStatus: SigningStatus.NOT_SIGNED,
        sendStatus: SendStatus.SENT,
        role: { not: RecipientRole.CC },
        OR: [{ expiresAt: null }, { expiresAt: { gt: claimedAt } }],
        envelope: {
          status: DocumentStatus.PENDING,
          deletedAt: null,
        },
      },
      data: {
        lastReminderSentAt: claimedAt,
        nextReminderAt: getReminderLeaseUntil(claimedAt),
      },
    });

    return { count: result.count, claimedAt: claimedAt.toISOString() };
  });

  if (claim.count === 0) {
    io.logger.info(`Recipient ${recipientId} no longer eligible for reminder, skipping`);
    return;
  }

  const now = new Date(claim.claimedAt);

  const recipient = await prisma.recipient.findFirst({
    where: { id: recipientId },
    include: {
      envelope: {
        include: {
          documentMeta: true,
          user: true,
          recipients: true,
          team: {
            select: {
              name: true,
            },
          },
        },
      },
    },
  });

  if (!recipient) {
    io.logger.warn(`Recipient ${recipientId} not found`);
    return;
  }

  const { envelope } = recipient;

  // Solid Ten: on a re-run the recipient may have signed since the claim.
  if (recipient.signingStatus !== SigningStatus.NOT_SIGNED || envelope.status !== DocumentStatus.PENDING) {
    io.logger.info(`Recipient ${recipientId} acted or the envelope moved since the claim, skipping`);
    await stopReminders(recipient.id);
    return;
  }

  if (!envelope.documentMeta) {
    io.logger.warn(`Envelope ${envelope.id} missing documentMeta`);
    await stopReminders(recipient.id);
    return;
  }

  // Skip if distribution method is NONE (manual link sharing, no emails).
  if (envelope.documentMeta.distributionMethod === DocumentDistributionMethod.NONE) {
    io.logger.info(`Envelope ${envelope.id} uses manual distribution, skipping email reminder`);
    await stopReminders(recipient.id);
    return;
  }

  const isSigningRequestEmailEnabled = extractDerivedDocumentEmailSettings(
    envelope.documentMeta,
  ).recipientSigningRequest;

  if (!isSigningRequestEmailEnabled && !isSigningSmsPossible(envelope.documentMeta)) {
    io.logger.info(`Envelope ${envelope.id} has email signing requests disabled, skipping`);
    await stopReminders(recipient.id);
    return;
  }

  const {
    branding,
    emailLanguage,
    organisationType,
    senderEmail,
    replyToEmail,
    organisationId,
    claims,
    emailsDisabled,
    emailTransport,
  } = await getEmailContext({
    emailType: 'RECIPIENT',
    source: {
      type: 'team',
      teamId: envelope.teamId,
    },
    meta: envelope.documentMeta,
  });

  // Don't send reminders if the owner is disabled (e.g. banned) or the organisation
  // has email sending disabled.
  if (envelope.user.disabled) {
    io.logger.info(`Envelope ${envelope.id} skipping reminder: owner disabled or organisation emails disabled`);
    await stopReminders(recipient.id);
    return;
  }

  // Solid Ten: the send, its audit entry and webhook run as one at-most-once task. A re-run after
  // a crash skips them, also when the crash hit during the send (a missing reminder is better than
  // a doubled one); the text uses an idempotency key either way. A skipped send still gets an
  // audit entry, marked as not confirmed (FS2-L2; reminder-count.ts).
  const sendTask = { cacheKey: 'send-reminder', onCutOff: createCutOffReminderRecorder({ envelope, recipient, now }) };

  await runTaskAtMostOnce(io, sendTask, async (markSending) => {
    let isCounted = false;

    // The reminder's number: the count before this send, plus one.
    const smsDelivery = await deliverSigningSms({
      envelope,
      recipient,
      purpose: 'REMINDER',
      idempotencyKey: buildSmsIdempotencyKey('REMINDER', recipient, recipient.reminderCount + 1),
      isSigningRequestEmailEnabled,
    });

    const shouldSendEmail = smsDelivery.shouldSendEmail && !emailsDisabled;

    if (!shouldSendEmail && smsDelivery.isSmsDelivered) {
      await triggerWebhook({
        event: WebhookTriggerEvents.DOCUMENT_REMINDER_SENT,
        data: ZWebhookDocumentSchema.parse(mapEnvelopeToWebhookDocumentPayload(envelope)),
        userId: envelope.userId,
        teamId: envelope.teamId,
      });
    }

    const i18n = await getI18nInstance(emailLanguage);

    const recipientActionVerb = i18n._(RECIPIENT_ROLES_DESCRIPTION[recipient.role].actionVerb).toLowerCase();

    let emailSubject = i18n._(msg`Reminder: Please ${recipientActionVerb} the document "${envelope.title}"`);

    if (organisationType === OrganisationType.ORGANISATION) {
      emailSubject = i18n._(msg`Reminder: ${envelope.team.name} invited you to ${recipientActionVerb} a document`);
    }

    const customEmailTemplate = {
      'signer.name': recipient.name,
      'signer.email': recipient.email,
      'document.name': envelope.title,
    };

    if (envelope.documentMeta.subject) {
      emailSubject = renderCustomEmailTemplate(
        i18n._(msg`Reminder: ${envelope.documentMeta.subject}`),
        customEmailTemplate,
      );
    }

    const emailMessage = envelope.documentMeta.message
      ? renderCustomEmailTemplate(envelope.documentMeta.message, customEmailTemplate)
      : undefined;

    const assetBaseUrl = NEXT_PUBLIC_WEBAPP_URL() || 'http://localhost:3000';
    const signDocumentLink = `${NEXT_PUBLIC_WEBAPP_URL()}/sign/${recipient.token}`;
    const reportUrl = `${NEXT_PUBLIC_WEBAPP_URL()}/report/${recipient.token}`;

    // Meter reminder emails against the organisation email quota/stats. Reminders
    // are unsolicited (the recipient didn't opt in to them) and can recur, so they
    // must be bounded by the same org limits as other outbound emails.
    const isRateLimited =
      !shouldSendEmail ||
      (await assertOrganisationRatesAndLimits({
        organisationId,
        organisationClaim: claims,
        type: 'email',
        count: 1,
      })
        .then(() => false)
        .catch((_err) => {
          io.logger.warn({
            msg: 'Signing reminder dropped: org email limit exceeded',
            organisationId,
            recipientId: recipient.id,
            envelopeId: envelope.id,
          });

          return true;
        }));

    if (!isRateLimited) {
      io.logger.info(
        `Sending signing reminder for envelope ${envelope.id} to recipient ${recipient.id} (${recipient.email})`,
      );

      const showNewAccountWarning =
        recipient.email !== envelope.user.email &&
        shouldShowNewAccountWarning({
          userCreatedAt: envelope.user.createdAt,
          organisationClaim: claims,
        });

      const template = createElement(DocumentReminderEmailTemplate, {
        recipientName: recipient.name,
        documentName: envelope.title,
        assetBaseUrl,
        signDocumentLink,
        customBody: emailMessage,
        role: recipient.role,
        reportUrl,
        newAccountWarningSenderEmail: showNewAccountWarning ? envelope.user.email : undefined,
      });

      const [html, text] = await Promise.all([
        renderEmailWithI18N(template, { lang: emailLanguage, branding }),
        renderEmailWithI18N(template, {
          lang: emailLanguage,
          branding,
          plainText: true,
        }),
      ]);

      // The count moves in the same transaction as the "sending" marker: counted exactly when the
      // send starts, never twice.
      await markSending(async (tx) => await countReminder(recipient.id, tx));
      isCounted = true;

      await emailTransport.sendMail({
        to: {
          name: recipient.name,
          address: recipient.email,
        },
        from: senderEmail,
        replyTo: replyToEmail,
        subject: emailSubject,
        html,
        text,
        headers: buildEnvelopeEmailHeaders({
          userId: envelope.userId,
          envelopeId: envelope.id,
          teamId: envelope.teamId,
        }),
      });

      await prisma.documentAuditLog.create({
        data: createDocumentAuditLogData({
          type: DOCUMENT_AUDIT_LOG_TYPE.EMAIL_SENT,
          envelopeId: envelope.id,
          data: {
            recipientEmail: recipient.email,
            recipientName: recipient.name,
            recipientId: recipient.id,
            recipientRole: recipient.role,
            emailType: DOCUMENT_EMAIL_TYPE.REMINDER,
            isResending: false,
          },
        }),
      });

      await triggerWebhook({
        event: WebhookTriggerEvents.DOCUMENT_REMINDER_SENT,
        data: ZWebhookDocumentSchema.parse(mapEnvelopeToWebhookDocumentPayload(envelope)),
        userId: envelope.userId,
        teamId: envelope.teamId,
      });
    }

    // A text-only reminder, or one the email limit dropped, counts as before.
    if (!isCounted) {
      await countReminder(recipient.id);
    }
  });

  // Solid Ten: read the count back; it includes this reminder and gates the next one.
  const reminderCount = await readReminderCount(recipient.id);

  if (recipient.sentAt) {
    await updateRecipientNextReminder({
      recipientId: recipient.id,
      envelopeId: envelope.id,
      sentAt: recipient.sentAt,
      lastReminderSentAt: now,
      reminderCount,
    });
  }
};
