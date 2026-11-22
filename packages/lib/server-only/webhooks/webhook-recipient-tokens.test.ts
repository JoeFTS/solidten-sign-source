import { describe, expect, it } from 'vitest';

import { stripWebhookRecipientTokens } from './webhook-recipient-tokens';

const recipient = (id: number) => ({ id, email: `r${id}@example.com`, token: `secret-token-${id}`, role: 'SIGNER' });

const document = () => ({
  id: 1,
  title: 'Lease',
  recipients: [recipient(1), recipient(2)],
  Recipient: [recipient(1), recipient(2)],
});

describe('stripWebhookRecipientTokens', () => {
  it('removes the token from both recipient lists and keeps every other field', () => {
    const stripped = stripWebhookRecipientTokens(document(), false);

    expect(JSON.stringify(stripped)).not.toContain('secret-token');
    expect(stripped.recipients[0]).toEqual({ id: 1, email: 'r1@example.com', role: 'SIGNER' });
    expect(stripped.Recipient).toHaveLength(2);
    expect(stripped.title).toBe('Lease');
  });

  it('strips inside a full delivery envelope', () => {
    const delivery = { event: 'DOCUMENT_COMPLETED', payload: document(), createdAt: 'x', webhookEndpoint: 'y' };

    expect(JSON.stringify(stripWebhookRecipientTokens(delivery, false))).not.toContain('secret-token');
  });

  it('leaves the input untouched and keeps tokens when the operator opts in', () => {
    const input = document();

    stripWebhookRecipientTokens(input, false);

    expect(input.recipients[0].token).toBe('secret-token-1');
    expect(stripWebhookRecipientTokens(input, true)).toBe(input);
  });

  it('passes non-objects through', () => {
    expect(stripWebhookRecipientTokens(null, false)).toBeNull();
    expect(stripWebhookRecipientTokens('text', false)).toBe('text');
  });
});
