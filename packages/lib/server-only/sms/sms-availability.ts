import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';
import type { DocumentMeta } from '@prisma/client';

import { isTspEnvelope } from '../../types/signature-level';
import type { TSmsPurpose } from '../../types/sms-audit-logs';
import { isSmsChannelRequested } from '../../utils/sms/channels';
import { isSmsProviderConfigured } from './sms-config';

// Keep this module free of lingui macros and of i18n-server. send-document and other modules
// that tests import load it at top level; under the Playwright runner (tsx, no macro transform)
// a macro import anywhere in that chain makes every spec that reaches it fail to load.
// The delivery code itself (deliver-signing-sms) is loaded with a dynamic import or from lazily
// loaded job handlers.

/**
 * Text delivery is built for version-2 envelopes with simple electronic signatures only.
 */
export const isSmsSupportedEnvelope = (envelope: { internalVersion: number; signatureLevel: string }) =>
  envelope.internalVersion === 2 && !isTspEnvelope(envelope);

/**
 * Cheap check without database reads, for code that only decides whether to queue the job.
 */
export const isSigningSmsPossible = (documentMeta: Pick<DocumentMeta, 'signingChannel'> | null | undefined) =>
  isSmsChannelRequested(documentMeta?.signingChannel) && isSmsProviderConfigured();

/**
 * A short, non-reversible tag for the recipient's current signing link. A handover issues
 * a new token, so the new person's messages get keys of their own and are never mistaken
 * for duplicates of what the previous person was sent.
 */
export const getSigningLinkGeneration = (token: string) => bytesToHex(sha256(token)).slice(0, 12);

export const buildSmsIdempotencyKey = (
  purpose: TSmsPurpose,
  recipient: { id: number; token: string },
  discriminator?: string | number,
) => {
  const base = `${purpose}:${recipient.id}:${getSigningLinkGeneration(recipient.token)}`;

  return discriminator === undefined ? base : `${base}:${discriminator}`;
};
