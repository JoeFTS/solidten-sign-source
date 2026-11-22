// Verify a Solid Ten Sign webhook. Node 18+; no packages needed.
//
//   import { verifySolidTenWebhook } from './verify-signature.mjs';
//
//   const result = verifySolidTenWebhook({
//     secret: process.env.SOLIDTEN_WEBHOOK_SECRET,
//     rawBody,                                   // the request body exactly as received, as a string
//     timestamp: req.headers['x-solidten-timestamp'],
//     signature: req.headers['x-solidten-signature'],
//   });
//
//   if (!result.valid) return res.status(401).end();

import { createHmac, timingSafeEqual } from 'node:crypto';

const TOLERANCE_SECONDS = 300;

export const verifySolidTenWebhook = ({ secret, rawBody, timestamp, signature, nowSeconds }) => {
  if (!secret || !timestamp || !signature) {
    return { valid: false, reason: 'missing header or secret' };
  }

  if (!/^\d+$/.test(timestamp) || !/^v1=[0-9a-f]{64}$/.test(signature)) {
    return { valid: false, reason: 'malformed header' };
  }

  const now = nowSeconds ?? Math.floor(Date.now() / 1000);

  // Refuse old deliveries: a captured request cannot be replayed after five minutes.
  if (Math.abs(now - Number(timestamp)) > TOLERANCE_SECONDS) {
    return { valid: false, reason: 'timestamp outside tolerance' };
  }

  const expected = `v1=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex')}`;

  const a = Buffer.from(expected);
  const b = Buffer.from(signature);

  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { valid: false, reason: 'signature mismatch' };
  }

  return { valid: true };
};
