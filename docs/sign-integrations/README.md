# Solid Ten Sign integrations

Solid Ten Sign connects to other tools in two ways:

1. **Webhooks out.** Solid Ten Sign calls your URL when something happens (a document is sent, signed, completed, rejected, cancelled, a reminder goes out). Set them up in **Team settings > Webhooks**.
2. **API in.** Your tool calls the Solid Ten Sign API to create, send and read documents. Make an API token in **Team settings > API tokens**. The API reference is at `https://<your-host>/api/v2/openapi.json`.

With these two, n8n, Zapier and Make can join Solid Ten Sign to the other apps you use.

| Guide | Use it for |
| --- | --- |
| [Webhook signatures](./webhook-signatures.md) | Check that a webhook really came from your Solid Ten Sign server |
| [n8n](./n8n.md) | Self-hosted automation. Two workflows you can import |
| [Zapier](./zapier.md) | Zapier with "Webhooks by Zapier" |
| [Make](./make.md) | Make (formerly Integromat) |

## Before you start

- Your Solid Ten Sign server must be able to reach the automation tool, and the tool must be able to reach your server's API.
- If the automation tool runs on your own network (for example n8n on the same machine), Solid Ten Sign refuses private addresses by default. To allow one host, list it in `NEXT_PRIVATE_WEBHOOK_SSRF_BYPASS_HOSTS` (comma separated, for example `n8n.internal,10.0.0.12`) and restart. The webhook form and the delivery code use the same list. Only list hosts you control.
- Always set a webhook secret. Without one, deliveries are not signed.
- Make your receiver idempotent. A failed call is retried for about 8.5 hours, and a manual resend repeats an event, so the same event can arrive more than once. See [webhook signatures](./webhook-signatures.md#answer-fast-and-expect-repeats).
- Webhook payloads do not include recipients' signing tokens. See [webhook signatures](./webhook-signatures.md#recipient-tokens-are-not-sent).
