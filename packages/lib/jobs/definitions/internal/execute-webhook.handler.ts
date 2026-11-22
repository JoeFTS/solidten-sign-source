import { isWebhookForPurgedComment } from '@documenso/lib/server-only/retention/purge-envelope-copies';
import { executeWebhookCall } from '@documenso/lib/server-only/webhooks/execute-webhook-call';
import { stripWebhookRecipientTokens } from '@documenso/lib/server-only/webhooks/webhook-recipient-tokens';
import { getNextWebhookAttemptAt } from '@documenso/lib/server-only/webhooks/webhook-retry';
import { prisma } from '@documenso/prisma';
import type { Prisma } from '@prisma/client';
import { WebhookCallStatus } from '@prisma/client';

import type { JobRunIO } from '../../client/_internal/job';
import type { TExecuteWebhookJobDefinition } from './execute-webhook';
import { endWebhookRetryLease, isWebhookRetryStillOwed } from './webhook-retry-lease';

export const run = async ({ payload, io: _io }: { payload: TExecuteWebhookJobDefinition; io: JobRunIO }) => {
  const { event, webhookId, data, attempt = 1, retryOfCallId } = payload;

  // Solid Ten: a retry whose attempt is already recorded (a re-run, or a second claim after the
  // lease ended) is not delivered again.
  if (retryOfCallId && !(await isWebhookRetryStillOwed(retryOfCallId))) {
    return { success: true, status: 0, skipped: true };
  }

  if (await isWebhookForPurgedComment(event, data)) {
    return { success: true, status: 0, skipped: true };
  }

  const webhook = await prisma.webhook.findUniqueOrThrow({
    where: {
      id: webhookId,
    },
  });

  const { webhookUrl: url, secret } = webhook;

  const payloadData = {
    event,
    // Also covers test events and resends of calls stored before tokens were stripped.
    payload: stripWebhookRecipientTokens(data),
    createdAt: new Date().toISOString(),
    webhookEndpoint: url,
  };

  const result = await executeWebhookCall({ url, body: payloadData, secret });

  const createCall = prisma.webhookCall.create({
    data: {
      url,
      event,
      status: result.success ? WebhookCallStatus.SUCCESS : WebhookCallStatus.FAILED,
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      requestBody: payloadData as Prisma.InputJsonValue,
      responseCode: result.responseCode,
      responseBody: result.responseBody,
      responseHeaders: result.responseHeaders,
      webhookId: webhook.id,
      attempt,
      nextAttemptAt: result.success || result.isFinal || !webhook.enabled ? null : getNextWebhookAttemptAt(attempt),
    },
  });

  // Solid Ten: record the attempt and end the original call's lease together.
  await prisma.$transaction([createCall, ...(retryOfCallId ? [endWebhookRetryLease(retryOfCallId)] : [])]);

  // Solid Ten: no throw on failure. A throw made the job runner retry at once (four tries in
  // about 25 ms); the retry sweep now retries on a schedule from nextAttemptAt instead.
  if (!result.success) {
    return {
      success: false,
      status: result.responseCode,
    };
  }

  return {
    success: true,
    status: result.responseCode,
  };
};
