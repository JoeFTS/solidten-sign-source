# Webhook signatures

Every webhook delivery from a webhook that has a secret carries three headers:

| Header | Value |
| --- | --- |
| `X-SolidTen-Timestamp` | Unix time in seconds when the delivery was signed |
| `X-SolidTen-Signature` | `v1=` followed by the hex HMAC-SHA256 of `<timestamp>.<raw body>`, keyed with the webhook secret |
| `X-Documenso-Secret` | The secret itself. Kept for older receivers; do not rely on it |

The plain secret header proves nothing to a receiver if the request was copied or forwarded. The signature does: only someone with the secret can make it, it covers the exact body, and it covers the time.

## How to check a delivery

1. Read the raw request body as text. Do not parse and re-serialise it first.
2. Read `X-SolidTen-Timestamp`. Refuse the request if it is more than 300 seconds from your clock. This stops replays.
3. Compute `HMAC-SHA256(secret, timestamp + "." + rawBody)` as lower-case hex and put `v1=` in front.
4. Compare it with `X-SolidTen-Signature` using a constant-time comparison. Refuse the request if they differ.
5. Optional: store the `createdAt` and `payload.id` of deliveries you processed, and skip repeats. A manual "resend" from the webhook page is signed again with a new timestamp.

## Node.js

[`examples/verify-signature.mjs`](./examples/verify-signature.mjs) is a complete verifier with no dependencies. The Solid Ten Sign test suite runs it against real signatures, replays and tampered bodies.

Express example:

```js
import express from 'express';
import { verifySolidTenWebhook } from './verify-signature.mjs';

const app = express();

app.post('/solidten', express.text({ type: 'application/json' }), (req, res) => {
  const result = verifySolidTenWebhook({
    secret: process.env.SOLIDTEN_WEBHOOK_SECRET,
    rawBody: req.body,
    timestamp: req.get('x-solidten-timestamp'),
    signature: req.get('x-solidten-signature'),
  });

  if (!result.valid) {
    return res.status(401).send(result.reason);
  }

  const event = JSON.parse(req.body);
  // event.event is for example "DOCUMENT_COMPLETED"; event.payload is the document.

  res.status(200).end();
});
```

## Python

```python
import hashlib, hmac, time

def verify(secret: str, raw_body: bytes, timestamp: str, signature: str) -> bool:
    if not timestamp or not signature or not timestamp.isdigit():
        return False
    if abs(int(time.time()) - int(timestamp)) > 300:
        return False
    signed = timestamp.encode() + b"." + raw_body
    expected = "v1=" + hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)
```

## Answer fast, and expect repeats

Solid Ten Sign waits 10 seconds for an answer and does not follow redirects. Answer `2xx` first and do slow work afterwards.

A non-`2xx` answer, a timeout or a network error marks the call as failed. Solid Ten Sign then tries again after about 1 minute, 5 minutes, 30 minutes, 2 hours and 6 hours: six attempts in all. Each attempt is signed again with a new timestamp. Every attempt and its status shows on the webhook page, where you can also resend a call by hand or send a test event.

**Your receiver must be idempotent.** The same event can arrive more than once: after a retry, after a manual resend, or when your receiver did the work but answered too late. Use `payload.id` (or `payload.envelopeId`) together with `event` as the key, and skip an event you already handled.

## Recipient tokens are not sent

Webhook payloads list the recipients but leave out each recipient's signing `token`. The token is the signing credential: anyone who has it can sign as that recipient, so it must not sit in Zapier, n8n or a log store.

If an older integration needs the token, the server operator can set `NEXT_PRIVATE_WEBHOOK_INCLUDE_RECIPIENT_TOKENS=true` and restart. Only do this when every webhook receiver is trusted as much as the signers' email inboxes. To send someone a signing link from an automation, use the API instead: `POST /api/v2/envelope/use` returns each recipient's signing URL to the caller.
