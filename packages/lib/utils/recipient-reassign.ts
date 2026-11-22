import { DocumentStatus, RecipientRole, SigningStatus } from '@prisma/client';

import { isTspEnvelope } from '../types/signature-level';

export type RecipientReassignActor = 'SIGNER' | 'SENDER';

export type RecipientReassignBlockReason =
  | 'ENVELOPE_LEGACY'
  | 'ENVELOPE_TSP'
  | 'ENVELOPE_NOT_PENDING'
  | 'RECIPIENT_ALREADY_ACTED'
  | 'RECIPIENT_IS_CC'
  | 'RECIPIENT_EXPIRED'
  | 'ACCESS_AUTH_NOT_VERIFIABLE'
  | 'NOT_ALLOWED_BY_SETTINGS';

export const RECIPIENT_REASSIGN_BLOCK_MESSAGES: Record<RecipientReassignBlockReason, string> = {
  ENVELOPE_LEGACY: 'Reassigning is only available for documents made in the current editor.',
  ENVELOPE_TSP: 'Reassigning is not available for qualified-signature documents.',
  ENVELOPE_NOT_PENDING: 'Only documents that are waiting for signatures can be reassigned.',
  RECIPIENT_ALREADY_ACTED: 'This recipient has already signed or rejected the document.',
  RECIPIENT_IS_CC: 'Copy recipients cannot be reassigned. Edit them instead.',
  RECIPIENT_EXPIRED: 'This signing link has expired. Ask the sender to reassign it.',
  ACCESS_AUTH_NOT_VERIFIABLE: 'This document needs extra verification. Ask the sender to reassign it.',
  NOT_ALLOWED_BY_SETTINGS: 'Reassigning is turned off for this team.',
};

type ReassignEligibilityOptions = {
  actor: RecipientReassignActor;
  envelope: { status: DocumentStatus; internalVersion: number; signatureLevel: string };
  recipient: { role: RecipientRole; signingStatus: SigningStatus; expiresAt: Date | null };
  settings: { allowSenderReassign: boolean; allowSignerReassign: boolean };
  /**
   * The access methods the recipient must pass, e.g. ['ACCOUNT'] or ['TWO_FACTOR_AUTH'].
   */
  accessAuthMethods: string[];
  now: Date;
};

/**
 * Why a recipient cannot be reassigned right now, or null when they can.
 *
 * A signer acting through their link is held to more rules than the sender: their
 * link must not have expired, and any access check other than "signed in to the
 * matching account" cannot be re-proved from the link alone, so it is refused.
 */
export const getRecipientReassignBlockReason = ({
  actor,
  envelope,
  recipient,
  settings,
  accessAuthMethods,
  now,
}: ReassignEligibilityOptions): RecipientReassignBlockReason | null => {
  if (envelope.internalVersion !== 2) {
    return 'ENVELOPE_LEGACY';
  }

  if (isTspEnvelope(envelope)) {
    return 'ENVELOPE_TSP';
  }

  if (envelope.status !== DocumentStatus.PENDING) {
    return 'ENVELOPE_NOT_PENDING';
  }

  if (recipient.signingStatus !== SigningStatus.NOT_SIGNED) {
    return 'RECIPIENT_ALREADY_ACTED';
  }

  if (recipient.role === RecipientRole.CC) {
    return 'RECIPIENT_IS_CC';
  }

  const isAllowed = actor === 'SIGNER' ? settings.allowSignerReassign : settings.allowSenderReassign;

  if (!isAllowed) {
    return 'NOT_ALLOWED_BY_SETTINGS';
  }

  if (actor === 'SIGNER') {
    if (recipient.expiresAt && recipient.expiresAt.getTime() <= now.getTime()) {
      return 'RECIPIENT_EXPIRED';
    }

    const hasUnverifiableAccessAuth = accessAuthMethods.some(
      (method) => method !== 'ACCOUNT' && method !== 'EXPLICIT_NONE',
    );

    if (hasUnverifiableAccessAuth) {
      return 'ACCESS_AUTH_NOT_VERIFIABLE';
    }
  }

  return null;
};

/**
 * Whether the new email already belongs to a recipient on the envelope (the
 * recipient being reassigned included). Emails are compared case-insensitively.
 */
export const isReassignEmailTaken = ({
  recipients,
  newEmail,
}: {
  recipients: { email: string }[];
  newEmail: string;
}) => {
  const normalized = newEmail.trim().toLowerCase();

  return recipients.some((recipient) => recipient.email.trim().toLowerCase() === normalized);
};
