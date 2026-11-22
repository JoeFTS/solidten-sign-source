import type { WebhookTriggerEvents } from '@prisma/client';

import { jobs } from '../../../jobs/client';
import { addAttachedFilesToWebhookData } from '../../field-file/webhook-attached-files';
import { getAllWebhooksByEventTrigger } from '../get-all-webhooks-by-event-trigger';
import { stripWebhookRecipientTokens } from '../webhook-recipient-tokens';

export type TriggerWebhookOptions = {
  event: WebhookTriggerEvents;
  data: Record<string, unknown>;
  userId: number;
  teamId: number;
  /**
   * Solid Ten: queue each webhook's delivery at most once for this key (FS2-L1), so a job that
   * re-runs after a crash does not deliver the event twice.
   */
  idempotencyKey?: string;
};

export const triggerWebhook = async ({ event, data, userId, teamId, idempotencyKey }: TriggerWebhookOptions) => {
  try {
    const registeredWebhooks = await getAllWebhooksByEventTrigger({ event, userId, teamId });

    if (registeredWebhooks.length === 0) {
      return;
    }

    // Solid Ten: list attached files (metadata only).
    const enrichedData = await addAttachedFilesToWebhookData(data);

    await Promise.allSettled(
      registeredWebhooks.map(async (webhook) => {
        await jobs.triggerJob({
          id: idempotencyKey ? `webhook:${idempotencyKey}:${event}:${webhook.id}` : undefined,
          name: 'internal.execute-webhook',
          payload: {
            event,
            webhookId: webhook.id,
            // Strip before queueing so the background job row never stores signing tokens.
            data: stripWebhookRecipientTokens(enrichedData),
          },
        });
      }),
    );
  } catch (err) {
    console.error(err);
    throw new Error(`Failed to trigger webhook`);
  }
};
