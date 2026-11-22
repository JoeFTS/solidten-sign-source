import { createRateLimit } from './rate-limit';

// ---- Auth (Tier 1 - Critical, sends emails) ----

export const signupRateLimit = createRateLimit({
  action: 'auth.signup',
  max: 3,
  window: '3h',
});

export const forgotPasswordRateLimit = createRateLimit({
  action: 'auth.forgot-password',
  max: 3,
  globalMax: 20,
  window: '1h',
});

export const resendVerifyEmailRateLimit = createRateLimit({
  action: 'auth.resend-verify-email',
  max: 3,
  globalMax: 20,
  window: '1h',
});

export const request2FAEmailRateLimit = createRateLimit({
  action: 'auth.request-2fa-email',
  max: 5,
  globalMax: 20,
  window: '15m',
});

// ---- Auth (Tier 2 - Unauthenticated) ----

export const loginRateLimit = createRateLimit({
  action: 'auth.login',
  max: 10,
  globalMax: 50,
  window: '15m',
});

export const resetPasswordRateLimit = createRateLimit({
  action: 'auth.reset-password',
  max: 5,
  globalMax: 20,
  window: '1h',
});

export const verifyEmailRateLimit = createRateLimit({
  action: 'auth.verify-email',
  max: 5,
  globalMax: 20,
  window: '15m',
});

export const passkeyRateLimit = createRateLimit({
  action: 'auth.passkey',
  max: 10,
  globalMax: 50,
  window: '15m',
});

export const linkOrgAccountRateLimit = createRateLimit({
  action: 'auth.link-org-account',
  max: 5,
  globalMax: 20,
  window: '1h',
});

export const embedAuthStartRateLimit = createRateLimit({
  action: 'auth.embed-start',
  max: 100,
  window: '15m',
});

// IP only: the nonce must never be a rate limit key (it would be persisted in plaintext).
// The client polls every 2s, so this allows ~40 concurrent flows behind one IP.
export const embedAuthRedeemRateLimit = createRateLimit({
  action: 'auth.embed-redeem',
  max: 1200,
  window: '1m',
});

// ---- Auth (Tier 3 - Authenticated, verifies secrets) ----

/**
 * Bounds guessing of the current password and 2FA code via the update password endpoint.
 */
export const updatePasswordRateLimit = createRateLimit({
  action: 'auth.update-password',
  max: 5,
  globalMax: 20,
  window: '15m',
});

export const reportSenderRateLimit = createRateLimit({
  action: 'recipient.report-sender',
  max: 1,
  window: '7d',
});

// ---- Embedding ----

export const persistEmbedSignatureRateLimit = createRateLimit({
  action: 'embed.persist-signature',
  max: 10,
  globalMax: 30,
  window: '1m',
});

// ---- Billing ----

export const syncSubscriptionRateLimit = createRateLimit({
  action: 'billing.sync-subscription',
  max: 10,
  window: '15m',
});

// ---- API (Tier 4 - Standard) ----

export const apiV1RateLimit = createRateLimit({
  action: 'api.v1',
  max: 1000,
  window: '1m',
});

export const apiV2RateLimit = createRateLimit({
  action: 'api.v2',
  max: 1000,
  window: '1m',
});

export const apiTrpcRateLimit = createRateLimit({
  action: 'api.trpc',
  max: 100,
  window: '1m',
});

/**
 * Solid Ten: token-authorized signing calls (sign or clear a field, complete, reject, the link
 * status poll), counted per recipient link (a hash of the token, never the token) with a per-IP
 * backstop. A signer with 150 fields, or an office of signers behind one NAT address, no longer
 * shares the 100-per-IP tRPC limit.
 */
export const apiTrpcSigningRateLimit = createRateLimit({
  action: 'api.trpc.signing',
  max: 600,
  globalMax: 3000,
  window: '1m',
});

/**
 * Solid Ten: signed-in staff calls, counted per session with a per-IP backstop.
 */
export const apiTrpcSessionRateLimit = createRateLimit({
  action: 'api.trpc.session',
  max: 600,
  globalMax: 3000,
  window: '1m',
});

/**
 * Solid Ten: field-file uploads, per IP only here; the upload procedure keeps its own per-IP and
 * per-recipient limits (fieldFileUploadRateLimit).
 */
export const apiTrpcFieldUploadRateLimit = createRateLimit({
  action: 'api.trpc.field-upload',
  max: 300,
  window: '1m',
});

export const aiRateLimit = createRateLimit({
  action: 'api.ai',
  max: 3,
  window: '1m',
});

export const fileUploadRateLimit = createRateLimit({
  action: 'api.file-upload',
  max: 20,
  window: '1m',
});

/**
 * Envelope content image uploads, kept separate from the document (PDF)
 * upload budget so placing several images does not block uploading a PDF.
 */
export const envelopeContentRateLimit = createRateLimit({
  action: 'api.envelope-content',
  max: 20,
  window: '1m',
});

// ---- Email-link sign-in (Solid Ten Sign) ----

/**
 * Per IP (20 an hour) and per email from one IP (5 an hour). Keyed by email and IP, so
 * requests from elsewhere cannot use up the owner's budget (S-M1).
 */
export const emailLinkRequestRateLimit = createRateLimit({
  action: 'auth.email-link-request',
  max: 5,
  globalMax: 20,
  window: '1h',
});

/**
 * A ceiling per email from all IPs together. Over it the request is still answered as
 * usual but no new link is sent: it only delays new links, it never blocks the owner from
 * the links already in their inbox (S-M1).
 */
export const emailLinkRequestEmailCeiling = createRateLimit({
  action: 'auth.email-link-request-email',
  max: 30,
  window: '1h',
});

export const emailLinkAuthorizeRateLimit = createRateLimit({
  action: 'auth.email-link-authorize',
  max: 10,
  globalMax: 50,
  window: '15m',
});
