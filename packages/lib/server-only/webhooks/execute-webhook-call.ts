import type { Prisma } from '@prisma/client';

import { assertNotPrivateUrl, isWebhookHostUnresolvedError, type TWebhookTarget } from './assert-webhook-url';
import { postPinned } from './pinned-request';
import { buildWebhookRequestHeaders } from './webhook-request-headers';

const WEBHOOK_TIMEOUT_MS = 10_000;

export type WebhookCallResult = {
  success: boolean;
  /** Solid Ten Sign: true when the call must not be retried (the address was refused). */
  isFinal: boolean;
  responseCode: number;
  responseBody: Prisma.InputJsonValue | Prisma.JsonNullValueInput;
  responseHeaders: Record<string, string>;
};

const parseBody = (text: string): Prisma.InputJsonValue => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

export const executeWebhookCall = async (options: {
  url: string;
  body: unknown;
  secret: string | null;
}): Promise<WebhookCallResult> => {
  const { url, body, secret } = options;

  // Solid Ten Sign (S-L4): a refusal by the address rule is final; it is not retried. A host that
  // did not resolve (a DNS outage, retest) is retried like any network failure.
  let target: TWebhookTarget;

  try {
    target = await assertNotPrivateUrl(url);
  } catch (err) {
    return {
      success: false,
      isFinal: !isWebhookHostUnresolvedError(err),
      responseCode: 0,
      responseBody: err instanceof Error ? err.message : 'The webhook address was refused',
      responseHeaders: {},
    };
  }

  try {
    // Sign the exact bytes we send; receivers verify the raw body, not a re-serialised copy.
    const bodyText = JSON.stringify(body);

    // Connect to the address that was checked, never to a second lookup.
    const response = await postPinned({
      url,
      body: bodyText,
      headers: buildWebhookRequestHeaders({ secret, bodyText }),
      pinned: target.pinned,
      timeoutMs: WEBHOOK_TIMEOUT_MS,
    });

    return {
      success: response.ok,
      isFinal: false,
      responseCode: response.status,
      responseBody: parseBody(response.text),
      responseHeaders: response.headers,
    };
  } catch (err) {
    return {
      success: false,
      isFinal: false,
      responseCode: 0,
      responseBody: err instanceof Error ? err.message : 'Unknown error',
      responseHeaders: {},
    };
  }
};
