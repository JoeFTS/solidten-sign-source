import { env } from '../../utils/env';
import { buildWebhookSignatureHeaders } from './webhook-signature';

/**
 * The headers of a webhook call.
 *
 * Solid Ten Sign (S-L4): the secret also goes as a plain `X-Documenso-Secret` header, for
 * receivers built before signed webhooks. With NEXT_PRIVATE_ST_WEBHOOK_SIGNED_ONLY=true
 * only the HMAC signature headers are sent, so the secret never travels with a request.
 */
export const buildWebhookRequestHeaders = ({
  secret,
  bodyText,
  isSignedOnly = env('NEXT_PRIVATE_ST_WEBHOOK_SIGNED_ONLY') === 'true',
}: {
  secret: string | null;
  bodyText: string;
  isSignedOnly?: boolean;
}): Record<string, string> => ({
  'Content-Type': 'application/json',
  ...(isSignedOnly ? {} : { 'X-Documenso-Secret': secret ?? '' }),
  ...buildWebhookSignatureHeaders({ secret, body: bodyText }),
});
