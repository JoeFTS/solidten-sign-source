import { prisma } from '@documenso/prisma';
import { SigningStatus, WebhookTriggerEvents } from '@prisma/client';

import { triggerWebhook } from '../../../server-only/webhooks/trigger/trigger-webhook';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../../types/document-audit-logs';
import { mapEnvelopeToWebhookDocumentPayload, ZWebhookDocumentSchema } from '../../../types/webhook-payload';
import { createDocumentAuditLogData } from '../../../utils/document-audit-logs';
import { jobs } from '../../client';
import type { JobRunIO } from '../../client/_internal/job';
import type { TProcessRecipientExpiredJobDefinition } from './process-recipient-expired';
import { isAbandonedExpiryClaim } from './recipient-expiry-claim';

export const run = async ({ payload, io }: { payload: TProcessRecipientExpiredJobDefinition; io: JobRunIO }) => {
  const { recipientId } = payload;

  // Atomic idempotency guard — only one concurrent worker wins.
  // Wrapping in runTask caches the result so that on retry the claim is not
  // re-evaluated and subsequent steps can still proceed.
  const claimedCount = await io.runTask('claim-recipient', async () => {
    const result = await prisma.recipient.updateMany({
      where: {
        id: recipientId,
        expirationNotifiedAt: null,
        signingStatus: { notIn: [SigningStatus.SIGNED, SigningStatus.REJECTED] },
      },
      data: { expirationNotifiedAt: new Date() },
    });

    // Solid Ten: a claim whose job died before this task was recorded (the re-run lands here
    // with count 0). Take it over when it is older than a minute and nothing was written yet;
    // the steps below are idempotent.
    if (result.count === 0 && (await isAbandonedExpiryClaim(recipientId))) {
      return 1;
    }

    return result.count;
  });

  if (claimedCount === 0) {
    io.logger.info(`Recipient ${recipientId} already processed or no longer eligible, skipping`);
    return;
  }

  // Fetch recipient (now marked) with its envelope for downstream steps.
  // Re-fetch after claiming so that expirationNotifiedAt reflects the updated value
  // and webhook consumers see consistent state.
  const recipient = await prisma.recipient.findUniqueOrThrow({
    where: { id: recipientId },
    include: {
      envelope: {
        include: { recipients: true, documentMeta: true },
      },
    },
  });

  const { envelope } = recipient;

  io.logger.info(`Recipient ${recipientId} (${recipient.email}) expired on envelope ${recipient.envelopeId}`);

  // Create audit log entry — wrapped so a retry skips this if it already succeeded.
  // Solid Ten: also skipped when a crash hit after the write but before the task was marked done.
  await io.runTask('create-audit-log', async () => {
    const existing = await prisma.documentAuditLog.findFirst({
      where: {
        envelopeId: recipient.envelopeId,
        type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_RECIPIENT_EXPIRED,
        data: { path: ['recipientId'], equals: recipient.id },
      },
      select: { id: true },
    });

    if (existing) {
      return;
    }

    await prisma.documentAuditLog.create({
      data: createDocumentAuditLogData({
        type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_RECIPIENT_EXPIRED,
        envelopeId: recipient.envelopeId,
        data: {
          recipientEmail: recipient.email,
          recipientName: recipient.name,
          recipientId: recipient.id,
        },
      }),
    });
  });

  // Trigger webhook for recipient expiration.
  // Solid Ten: in a task, so a re-run after a crash does not deliver it twice.
  await io.runTask('trigger-webhook', async () => {
    await triggerWebhook({
      event: WebhookTriggerEvents.RECIPIENT_EXPIRED,
      data: ZWebhookDocumentSchema.parse(mapEnvelopeToWebhookDocumentPayload(envelope)),
      userId: envelope.userId,
      teamId: envelope.teamId,
    });
  });

  // Trigger email notification to the document owner.
  // Solid Ten: in a task (it was outside, so a crash here lost the owner email), and with a fixed
  // id so a re-run that crashed after enqueueing cannot enqueue a second email.
  await io.runTask('notify-owner', async () => {
    await jobs.triggerJob({
      id: `recipient-expired-owner-email:${recipient.id}`,
      name: 'send.owner.recipient.expired.email',
      payload: {
        recipientId: recipient.id,
        envelopeId: recipient.envelopeId,
      },
    });
  });

  // Solid Ten: tell the signer too, so they know why their link stopped working.
  // In a task with a fixed id, like the owner email, so a re-run sends it once.
  await io.runTask('notify-signer', async () => {
    await jobs.triggerJob({
      id: `recipient-expired-signer-notice:${recipient.id}`,
      name: 'send.solidten.notice.email',
      payload: {
        kind: 'SIGNER_DEADLINE_PASSED',
        envelopeId: recipient.envelopeId,
        recipientId: recipient.id,
        recipientEmail: recipient.email,
      },
    });
  });
};
