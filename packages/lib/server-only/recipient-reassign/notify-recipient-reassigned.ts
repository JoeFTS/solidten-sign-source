import { prisma } from '@documenso/prisma';
import { DocumentDistributionMethod, DocumentSigningOrder, SendStatus, WebhookTriggerEvents } from '@prisma/client';

import { jobs } from '../../jobs/client';
import { mapEnvelopeToWebhookDocumentPayload, ZWebhookDocumentSchema } from '../../types/webhook-payload';
import type { RequestMetadata } from '../../universal/extract-request-metadata';
import { mapSecondaryIdToDocumentId } from '../../utils/envelope';
import { getRecipientsInActiveSigningStep } from '../../utils/recipient-groups';
import { isRecipientEmailValidForSending } from '../../utils/recipients';
import { triggerWebhook } from '../webhooks/trigger/trigger-webhook';

export type NotifyRecipientReassignedOptions = {
  envelopeId: string;
  recipientId: number;
  previous: { email: string; name: string; sendStatus: SendStatus };
  isSelfReassigned: boolean;
  /** The reason the signer gave, for the owner's notice. */
  reason?: string | null;
  requestMetadata?: RequestMetadata;
  /**
   * Off when the same person keeps the request (a phone change), so there is
   * nobody to tell that it was passed on.
   */
  shouldNotifyPrevious?: boolean;
};

/**
 * The side effects of handing a recipient to another person, run after the
 * change is committed: the new person's signing request, the old person's
 * notice, and the webhook.
 *
 * Only a recipient whose turn it is gets emailed now. Later steps of a
 * sequential order are emailed by the normal signing flow when their turn comes.
 */
export const notifyRecipientReassigned = async ({
  envelopeId,
  recipientId,
  previous,
  isSelfReassigned,
  reason,
  requestMetadata,
  shouldNotifyPrevious = true,
}: NotifyRecipientReassignedOptions) => {
  const envelope = await prisma.envelope.findFirstOrThrow({
    where: { id: envelopeId },
    include: { documentMeta: true, recipients: true },
  });

  const recipient = envelope.recipients.find((item) => item.id === recipientId);

  if (!recipient) {
    return;
  }

  const isInActiveStep =
    envelope.documentMeta?.signingOrder !== DocumentSigningOrder.SEQUENTIAL ||
    getRecipientsInActiveSigningStep(envelope.recipients).some((active) => active.id === recipient.id);

  const isEmailDistribution = envelope.documentMeta?.distributionMethod !== DocumentDistributionMethod.NONE;

  if (isInActiveStep && isEmailDistribution) {
    await jobs.triggerJob({
      name: 'send.signing.requested.email',
      payload: {
        userId: envelope.userId,
        documentId: mapSecondaryIdToDocumentId(envelope.secondaryId),
        recipientId: recipient.id,
        requestMetadata,
      },
    });
  }

  const wasAskedToAct = isInActiveStep || previous.sendStatus === SendStatus.SENT;

  if (shouldNotifyPrevious && wasAskedToAct && isEmailDistribution && isRecipientEmailValidForSending(previous)) {
    await jobs.triggerJob({
      name: 'send.solidten.notice.email',
      payload: {
        kind: 'RECIPIENT_REASSIGNED',
        envelopeId: envelope.id,
        oldEmail: previous.email,
        oldName: previous.name,
        // Solid Ten Sign (SEC2-M2): the old address learns who has the request only when they
        // passed it on themselves. A sender or admin correction names no one.
        ...(isSelfReassigned ? { newName: recipient.name || recipient.email } : {}),
        isSelfReassigned,
      },
    });
  }

  // Solid Ten Sign (S-L5): the owner hears when a signer hands their request to someone else.
  if (isSelfReassigned) {
    await jobs.triggerJob({
      name: 'send.solidten.notice.email',
      payload: {
        kind: 'RECIPIENT_SELF_REASSIGNED',
        envelopeId: envelope.id,
        fromEmail: previous.email,
        fromName: previous.name,
        toEmail: recipient.email,
        toName: recipient.name,
        reason: reason ?? null,
      },
    });
  }

  await triggerWebhook({
    event: WebhookTriggerEvents.RECIPIENT_REASSIGNED,
    data: ZWebhookDocumentSchema.parse(mapEnvelopeToWebhookDocumentPayload(envelope)),
    userId: envelope.userId,
    teamId: envelope.teamId,
  });
};
