# n8n

Two workflows you can import into n8n (Workflows > Import from file):

| File | What it does |
| --- | --- |
| [`n8n/document-completed-webhook.json`](./n8n/document-completed-webhook.json) | **Webhook in.** When a document is completed, check the signature, then run your step (save the PDF, update a CRM, post to chat). |
| [`n8n/create-and-send-from-template.json`](./n8n/create-and-send-from-template.json) | **API out.** Create a document from a template and send it to a signer. |

## 1. "When a document is completed, do X"

1. Import `document-completed-webhook.json`.
2. Open the **Verify signature** node. Replace `REPLACE_WITH_YOUR_WEBHOOK_SECRET` with the secret you will give the webhook.
3. The Code node uses Node's `crypto` module. On self-hosted n8n, start n8n with `NODE_FUNCTION_ALLOW_BUILTIN=crypto`. (n8n Cloud allows `crypto` already.)
4. Open the **Solid Ten Sign webhook** node and copy the **Production URL**.
5. In Solid Ten Sign, go to **Team settings > Webhooks > Create webhook**. Paste the URL, choose the `DOCUMENT_COMPLETED` event, set the same secret, and save.
6. Activate the workflow. On the webhook page in Solid Ten Sign, click **Test** to send a sample event, and check the n8n execution list.
7. Replace the **Your step here** node with what you want to happen. The document is in `{{$json.document}}`: `title`, `envelopeId`, `externalId`, `recipients`, `completedAt`.

The verify node refuses a delivery when the signature is wrong, when it is older than five minutes (replay), or when the event is not `DOCUMENT_COMPLETED`.

The same event can arrive more than once (retries, manual resends). Before a step that must not run twice, check whether you already handled this `document.envelopeId`, for example with n8n's **Remove Duplicates** node set to remove items processed in previous executions.

To download the signed PDF in a later step, call `GET https://<your-host>/api/v2/envelope/item/<envelopeItemId>/download` with your API token. Get the item id from `GET /api/v2/envelope/<envelopeId>`.

If n8n runs on your own network, add its host to `NEXT_PRIVATE_WEBHOOK_SSRF_BYPASS_HOSTS` on the Solid Ten Sign server (see the [overview](./README.md)).

## 2. "Create and send a document from a template"

1. Make a template in Solid Ten Sign with one signer placeholder and its fields.
2. Note the template's envelope id (in the template URL, it starts with `envelope_`) and the placeholder recipient's id (from `GET /api/v2/envelope/<templateEnvelopeId>`, `recipients[0].id`).
3. Make an API token: **Team settings > API tokens**.
4. In n8n, create a **Header Auth** credential: name `Authorization`, value `<your API token>`.
5. Import `create-and-send-from-template.json`. In **Document details**, set the host, template id, recipient id, signer name and email. In **Create and send**, pick your Header Auth credential.
6. Run it. The response holds the new document id and each recipient's signing URL.

The workflow starts with a manual trigger so you can test it. Swap it for any trigger: a form, a new CRM deal, a row in a sheet.

The call is `POST /api/v2/envelope/use` as `multipart/form-data` with one field, `payload`, holding JSON:

```json
{
  "envelopeId": "envelope_xxxxxxxx",
  "recipients": [{ "id": 123, "email": "signer@example.com", "name": "Sam Signer" }],
  "distributeDocument": true
}
```
