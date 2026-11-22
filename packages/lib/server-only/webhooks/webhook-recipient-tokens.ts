import { env } from '../../utils/env';

/**
 * A recipient token is the signing credential: whoever holds it can open the signing link and
 * sign as that recipient. Webhook receivers (Zapier, n8n, a log store) must not get it unless the
 * operator opts in for an integration built on the old payload shape.
 */
export const isWebhookRecipientTokenIncluded = () => env('NEXT_PRIVATE_WEBHOOK_INCLUDE_RECIPIENT_TOKENS') === 'true';

const RECIPIENT_LIST_KEYS = ['recipients', 'Recipient'] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stripDocument = (document: Record<string, unknown>) => {
  const copy: Record<string, unknown> = { ...document };

  for (const key of RECIPIENT_LIST_KEYS) {
    const list = copy[key];

    if (Array.isArray(list)) {
      copy[key] = list.map((recipient) => {
        if (!isRecord(recipient)) {
          return recipient;
        }

        const { token: _token, ...rest } = recipient;

        return rest;
      });
    }
  }

  return copy;
};

/**
 * Remove `token` from every recipient in a webhook document, or in a full delivery
 * (`{ event, payload, ... }`). Returns a copy; the input is not changed.
 */
export const stripWebhookRecipientTokens = <T>(data: T, include = isWebhookRecipientTokenIncluded()): T => {
  if (include || !isRecord(data)) {
    return data;
  }

  const stripped = stripDocument(data);

  if (isRecord(stripped.payload)) {
    stripped.payload = stripDocument(stripped.payload);
  }

  return stripped as T;
};
