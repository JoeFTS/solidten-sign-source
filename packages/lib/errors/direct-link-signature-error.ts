/**
 * Solid Ten Sign (O-F1): the database refuses a field change that takes a signer's last
 * signature field without a condition away while the template's direct link is on (migration
 * 20261123120000_st_direct_link_fixed_signature). Its error text carries a marker and the signer
 * ("direct" for the direct link signer). This turns it into the plain message a sender reads.
 *
 * No imports, so app-error.ts can use it.
 */
const MARKER = /ST_DIRECT_LINK_FIXED_SIGNATURE:([^\n"]*)/;
const SIGNER_MARKER = /ST_DIRECT_LINK_SIGNER:(removed|role)/;
const ENABLE_MARKER = /ST_DIRECT_LINK_ENABLE:(missing|role|signature)/;

/** Solid Ten Sign (Q-1): a link can only be turned on when a visitor can use it. */
export const DIRECT_LINK_ENABLE_MESSAGES = {
  missing:
    'The direct link cannot be turned on: its signer no longer exists. Choose a signer for the direct link first.',
  role: 'The direct link cannot be turned on: the direct link signer must be a signer. Change their role back to signer first.',
  signature:
    'The direct link cannot be turned on: the direct link signer needs at least one signature field without a condition.',
} as const;

/** Solid Ten Sign (P-2): the direct signer must stay a signer while the link is on. */
export const DIRECT_LINK_SIGNER_REMOVED_MESSAGE =
  'The direct link signer cannot be removed while the direct link is on. Turn the direct link off first.';
export const DIRECT_LINK_SIGNER_ROLE_MESSAGE =
  'The direct link signer must stay a signer while the direct link is on. Turn the direct link off first.';

export const DIRECT_LINK_FIXED_SIGNATURE_ADVICE =
  'This template has a direct link that is on, so visitors could not submit it. Keep one signature field without a condition, or turn the direct link off first.';

export const describeDirectLinkSignerForSender = (who: string) => {
  if (who === 'direct' || who === '') {
    return 'The direct link signer';
  }

  // A template's placeholder ("Recipient 1", recipient.1@documenso.com) reads like a number (O-F3).
  if (/^Recipient \d+$/i.test(who) || /^recipient\.\d+@documenso\.com$/i.test(who)) {
    return 'A signer with no name or email yet';
  }

  return who;
};

/** The plain message, or null when the error is not this refusal. */
export const readDirectLinkSignatureRefusal = (error: unknown): string | null => {
  let current: unknown = error;

  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth++) {
    const message = (current as { message?: unknown }).message;
    const match = typeof message === 'string' ? MARKER.exec(message) : null;

    const signerMatch = typeof message === 'string' ? SIGNER_MARKER.exec(message) : null;
    const enableMatch = typeof message === 'string' ? ENABLE_MARKER.exec(message) : null;

    if (enableMatch) {
      return DIRECT_LINK_ENABLE_MESSAGES[enableMatch[1] as keyof typeof DIRECT_LINK_ENABLE_MESSAGES];
    }

    if (signerMatch) {
      return signerMatch[1] === 'removed' ? DIRECT_LINK_SIGNER_REMOVED_MESSAGE : DIRECT_LINK_SIGNER_ROLE_MESSAGE;
    }

    if (match) {
      return `${describeDirectLinkSignerForSender(match[1].trim())} needs at least one signature field without a condition. ${DIRECT_LINK_FIXED_SIGNATURE_ADVICE}`;
    }

    current = (current as { cause?: unknown }).cause;
  }

  return null;
};
