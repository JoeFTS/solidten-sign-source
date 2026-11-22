import { webcrypto } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import { buildWebhookSignatureHeaders, signWebhookBody, verifyWebhookSignature } from './webhook-signature';

const SECRET = 'whsec_test_ÿ_secret';
const BODY = JSON.stringify({
  event: 'DOCUMENT_COMPLETED',
  payload: { id: 7, title: 'Lease, "unit 4" – Łódź 😀' },
  createdAt: '2026-11-20T10:00:00.000Z',
});
const NOW = new Date('2026-11-20T10:00:00Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

// Independent implementation: WebCrypto instead of node:crypto createHmac.
const independentSignature = async (secret: string, timestamp: number, body: string) => {
  const key = await webcrypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await webcrypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`));

  return `v1=${Buffer.from(mac).toString('hex')}`;
};

type TDocsVerifier = (options: {
  secret: string;
  rawBody: string;
  timestamp: string | undefined;
  signature: string | undefined;
  nowSeconds?: number;
}) => { valid: boolean; reason?: string };

let docsVerifier: TDocsVerifier;

beforeAll(async () => {
  const file = path.resolve(__dirname, '../../../../docs/sign-integrations/examples/verify-signature.mjs');
  const mod = await import(pathToFileURL(file).href);

  docsVerifier = mod.verifySolidTenWebhook;
});

describe('webhook signature', () => {
  it('matches an independent HMAC-SHA256 implementation', async () => {
    const headers = buildWebhookSignatureHeaders({ secret: SECRET, body: BODY, now: NOW });

    expect(headers['X-SolidTen-Timestamp']).toBe(String(NOW_SECONDS));
    expect(headers['X-SolidTen-Signature']).toBe(await independentSignature(SECRET, NOW_SECONDS, BODY));
  });

  it('sends no signature headers when the webhook has no secret', () => {
    expect(buildWebhookSignatureHeaders({ secret: null, body: BODY, now: NOW })).toEqual({});
    expect(buildWebhookSignatureHeaders({ secret: '', body: BODY, now: NOW })).toEqual({});
  });

  it('is accepted by the documented sample verifier and the reference verifier', () => {
    const headers = buildWebhookSignatureHeaders({ secret: SECRET, body: BODY, now: NOW });

    expect(
      docsVerifier({
        secret: SECRET,
        rawBody: BODY,
        timestamp: headers['X-SolidTen-Timestamp'],
        signature: headers['X-SolidTen-Signature'],
        nowSeconds: NOW_SECONDS + 10,
      }),
    ).toEqual({ valid: true });

    expect(
      verifyWebhookSignature({
        secret: SECRET,
        body: BODY,
        timestampHeader: headers['X-SolidTen-Timestamp'],
        signatureHeader: headers['X-SolidTen-Signature'],
        now: new Date(NOW.getTime() + 10_000),
      }),
    ).toEqual({ valid: true });
  });

  it('rejects a replay outside the five minute window', () => {
    const headers = buildWebhookSignatureHeaders({ secret: SECRET, body: BODY, now: NOW });

    const replay = {
      secret: SECRET,
      rawBody: BODY,
      timestamp: headers['X-SolidTen-Timestamp'],
      signature: headers['X-SolidTen-Signature'],
      nowSeconds: NOW_SECONDS + 301,
    };

    expect(docsVerifier(replay).valid).toBe(false);
    expect(docsVerifier({ ...replay, nowSeconds: NOW_SECONDS + 300 }).valid).toBe(true);

    expect(
      verifyWebhookSignature({
        secret: SECRET,
        body: BODY,
        timestampHeader: replay.timestamp,
        signatureHeader: replay.signature,
        now: new Date((NOW_SECONDS + 301) * 1000),
      }),
    ).toEqual({ valid: false, reason: 'EXPIRED' });
  });

  it('rejects a replay that swaps in a fresh timestamp', () => {
    const headers = buildWebhookSignatureHeaders({ secret: SECRET, body: BODY, now: NOW });

    expect(
      docsVerifier({
        secret: SECRET,
        rawBody: BODY,
        timestamp: String(NOW_SECONDS + 600),
        signature: headers['X-SolidTen-Signature'],
        nowSeconds: NOW_SECONDS + 600,
      }).valid,
    ).toBe(false);
  });

  it('rejects a tampered body, a tampered signature and the wrong secret', () => {
    const timestamp = String(NOW_SECONDS);
    const signature = signWebhookBody({ secret: SECRET, timestamp: NOW_SECONDS, body: BODY });
    const base = { secret: SECRET, rawBody: BODY, timestamp, signature, nowSeconds: NOW_SECONDS };

    expect(docsVerifier({ ...base, rawBody: BODY.replace('DOCUMENT_COMPLETED', 'DOCUMENT_REJECTED') }).valid).toBe(
      false,
    );
    expect(docsVerifier({ ...base, rawBody: JSON.stringify(JSON.parse(BODY), null, 2) }).valid).toBe(false);
    const flipped = `${signature.slice(0, -1)}${signature.endsWith('a') ? 'b' : 'a'}`;

    expect(docsVerifier({ ...base, signature: flipped }).valid).toBe(false);
    expect(docsVerifier({ ...base, secret: 'other' }).valid).toBe(false);
    expect(docsVerifier({ ...base, signature: undefined }).valid).toBe(false);

    expect(
      verifyWebhookSignature({
        secret: SECRET,
        body: `${BODY} `,
        timestampHeader: timestamp,
        signatureHeader: signature,
        now: NOW,
      }),
    ).toEqual({ valid: false, reason: 'MISMATCH' });
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        body: BODY,
        timestampHeader: '12a',
        signatureHeader: signature,
        now: NOW,
      }),
    ).toEqual({ valid: false, reason: 'MALFORMED' });
  });
});
