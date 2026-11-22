# Zapier

There is no Solid Ten Sign app in the Zapier directory. Use the built-in **Webhooks by Zapier** steps instead. They do the same job for a self-hosted server.

Check your Zapier plan: Webhooks by Zapier and Code by Zapier are not on every plan.

## Trigger: "when something happens in Solid Ten Sign"

1. Create a Zap. For the trigger, pick **Webhooks by Zapier**.
2. Pick the event:
   - **Catch Raw Hook** if you want to check the signature (recommended). It gives the unparsed body and the headers. The limit is 2 MB including headers. Solid Ten Sign payloads are a few kilobytes, so this is enough.
   - **Catch Hook** if you only need the fields. It parses the JSON for you (limit 10 MB) but does not give you the headers, so you cannot check the signature.
3. Copy the webhook URL Zapier shows (`https://hooks.zapier.com/hooks/catch/...`).
4. In Solid Ten Sign, go to **Team settings > Webhooks > Create webhook**. Paste the URL, choose the events, set a secret, and save.
5. Click **Test** on the webhook page in Solid Ten Sign, then **Test trigger** in Zapier.

### Check the signature (Catch Raw Hook)

Add a **Code by Zapier > Run JavaScript** step right after the trigger. Map these input fields:

- `rawBody` ← the trigger's raw body
- `timestamp` ← header `X-SolidTen-Timestamp` (Zapier shows it as `Http X Solidten Timestamp`)
- `signature` ← header `X-SolidTen-Signature`

Code:

```js
const crypto = require('crypto');
const secret = 'REPLACE_WITH_YOUR_WEBHOOK_SECRET';
const { rawBody, timestamp, signature } = inputData;

if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 300) {
  throw new Error('Delivery too old');
}

const expected = 'v1=' + crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');

if (expected !== signature) {
  throw new Error('Bad signature');
}

const event = JSON.parse(rawBody);

return { event: event.event, title: event.payload.title, envelopeId: event.payload.envelopeId };
```

A thrown error stops the Zap run, so a forged or replayed delivery never reaches your next steps.

Add a **Filter** step if you only want one event, for example `event` exactly matches `DOCUMENT_COMPLETED`.

The same event can arrive more than once (Solid Ten Sign retries failed calls, and a manual resend repeats one). Make the later steps safe to repeat, for example "find or create" actions keyed on `envelopeId`.

Zapier answers the webhook with `200` as soon as it receives it. That means "received", not "your Zap finished". Failures in later steps show in Zapier's Zap history, not on the Solid Ten Sign webhook page.

## Action: "create and send a document in Solid Ten Sign"

Use **Webhooks by Zapier > Custom Request** (or **API Request** if your plan has it):

- Method: `POST`
- URL: `https://<your-host>/api/v2/envelope/use`
- Headers: `Authorization: <your API token>`
- Body: multipart form data with one field, `payload`, holding the JSON from the [n8n guide](./n8n.md#2-create-and-send-a-document-from-a-template).

If a step cannot send multipart data, put a small n8n or serverless function in between, or use the older JSON endpoint `POST /api/v2/template/use` (deprecated, but still served).

## Older Zapier REST hooks

The server still serves `/api/v1/zapier/subscribe`, `/unsubscribe` and `/list-documents` for a private Zapier app built on the Zapier Platform. You do not need them for the steps above.
