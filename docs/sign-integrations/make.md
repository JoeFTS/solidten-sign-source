# Make

Make works the same way as Zapier: a webhook in, an HTTP call out.

## Webhook in

1. Add the **Webhooks > Custom webhook** module and create a webhook. Copy its URL.
2. In the webhook's advanced settings, turn on **Get request headers** so the signature headers reach your scenario.
3. In Solid Ten Sign, create a webhook with that URL, your events and a secret. Click **Test** to send a sample so Make can learn the data structure.
4. To check the signature, compute `HMAC-SHA256(secret, timestamp + "." + body)` as hex, put `v1=` in front, and compare it with the `x-solidten-signature` header. Make's built-in `sha256(text; [encoding]; [key])` function does keyed HMAC. The custom webhook module parses the JSON by default. Turn on **JSON pass-through** in its advanced settings so you hash the exact text that was sent. See [webhook signatures](./webhook-signatures.md) for the full rules.
5. The same event can arrive more than once. Key later modules on `envelopeId` (for example search before create) so a repeat does no harm.

## API out

Use **HTTP > Make a request**:

- URL: `https://<your-host>/api/v2/envelope/use`, method `POST`
- Header `Authorization: <your API token>`
- Body type **Multipart/form-data**, one field `payload` with the JSON from the [n8n guide](./n8n.md#2-create-and-send-a-document-from-a-template).

Make's option names change from time to time. If a name above does not match what you see, the idea stays the same: keep the headers, hash the raw body, and send `payload` as a form field.
