import type { Envelope, Recipient } from '@prisma/client';
import { DocumentSigningOrder, DocumentStatus, RecipientRole, SigningStatus } from '@prisma/client';

import type { TRecipientAccessAuthTypes, TRecipientActionAuthTypes } from '../types/document-auth';
import { DocumentAuth } from '../types/document-auth';
import { isTspEnvelope } from '../types/signature-level';
import { isRecipientTurnBySigningOrder } from './recipient-groups';
import { isRecipientExpired } from './recipients';

/** How long an in-person session may run before it ends by itself. */
export const IN_PERSON_SESSION_LIFETIME_MS = 1000 * 60 * 60 * 8;

/** Wrong PIN entries allowed before the device is signed out. */
export const IN_PERSON_MAX_PIN_ATTEMPTS = 5;

export const IN_PERSON_PIN_REGEX = /^\d{4,8}$/;

export const isValidInPersonPin = (pin: string) => IN_PERSON_PIN_REGEX.test(pin);

export type InPersonEnvelopeBlockReason = 'NOT_PENDING' | 'VERSION_1' | 'TSP' | 'DELETED' | 'NOT_ALLOWED_BY_SETTINGS';

export const IN_PERSON_ENVELOPE_BLOCK_MESSAGES: Record<InPersonEnvelopeBlockReason, string> = {
  NOT_PENDING: 'In-person signing is only possible while the document is waiting for signatures.',
  VERSION_1: 'In-person signing is not available for documents created with the older editor.',
  TSP: 'In-person signing is not available for documents that need an advanced or qualified signature.',
  DELETED: 'This document was deleted.',
  NOT_ALLOWED_BY_SETTINGS: 'In-person signing is turned off for this team.',
};

/**
 * Documents created from a public form (source TEMPLATE_DIRECT_LINK) are treated
 * like any other pending document on purpose: the form's submitter has already
 * signed, and any other recipients of the template sign normally, so they may
 * also be hosted in person.
 */
export const getInPersonEnvelopeBlockReason = ({
  envelope,
  allowInPersonSigning,
}: {
  envelope: Pick<Envelope, 'status' | 'internalVersion' | 'deletedAt' | 'signatureLevel'>;
  allowInPersonSigning: boolean;
}): InPersonEnvelopeBlockReason | null => {
  if (!allowInPersonSigning) {
    return 'NOT_ALLOWED_BY_SETTINGS';
  }

  if (envelope.deletedAt) {
    return 'DELETED';
  }

  if (envelope.internalVersion !== 2) {
    return 'VERSION_1';
  }

  if (isTspEnvelope(envelope)) {
    return 'TSP';
  }

  if (envelope.status !== DocumentStatus.PENDING) {
    return 'NOT_PENDING';
  }

  return null;
};

export type InPersonSignerBlockReason = 'ACCOUNT_REQUIRED' | 'HOST_IS_RECIPIENT' | 'EXPIRED' | 'NO_EMAIL';

export const IN_PERSON_SIGNER_BLOCK_MESSAGES: Record<InPersonSignerBlockReason, string> = {
  ACCOUNT_REQUIRED:
    'This signer must sign in to their own account to sign. Send them their link instead of signing in person.',
  HOST_IS_RECIPIENT: 'You are this signer. Sign from your own link instead of in person.',
  EXPIRED: "This signer's signing window has expired.",
  NO_EMAIL: 'This signer has no email address.',
};

/**
 * Why a recipient cannot sign on the host's device, or null when they can.
 *
 * Every action check except "none" depends on the signer's own account (account,
 * passkey, authenticator code, password). On the host's device the only signed-in
 * account is the host's, so those signers are refused. An access check by email
 * code is fine: the code goes to the signer's own email.
 */
export const getInPersonSignerBlockReason = ({
  recipient,
  accessAuth,
  actionAuth,
  hostEmail,
}: {
  recipient: Pick<Recipient, 'email' | 'expiresAt'>;
  accessAuth: TRecipientAccessAuthTypes[];
  actionAuth: TRecipientActionAuthTypes[];
  hostEmail: string;
}): InPersonSignerBlockReason | null => {
  if (!recipient.email) {
    return 'NO_EMAIL';
  }

  if (recipient.email.toLowerCase() === hostEmail.toLowerCase()) {
    return 'HOST_IS_RECIPIENT';
  }

  if (accessAuth.includes(DocumentAuth.ACCOUNT)) {
    return 'ACCOUNT_REQUIRED';
  }

  if (actionAuth.some((auth) => auth !== DocumentAuth.EXPLICIT_NONE)) {
    return 'ACCOUNT_REQUIRED';
  }

  if (isRecipientExpired(recipient)) {
    return 'EXPIRED';
  }

  return null;
};

type TurnRecipient = Pick<Recipient, 'id' | 'role' | 'signingStatus' | 'signingOrder'>;

/**
 * The recipients whose turn it is now: every pending non-CC recipient for
 * parallel signing, or the pending members of the active step for sequential
 * signing. Same rule as the signing page.
 */
export const getInPersonTurnRecipients = <T extends TurnRecipient>(
  recipients: T[],
  signingOrder: DocumentSigningOrder | null | undefined,
): T[] => {
  const pending = recipients.filter(
    (recipient) => recipient.role !== RecipientRole.CC && recipient.signingStatus === SigningStatus.NOT_SIGNED,
  );

  if (signingOrder !== DocumentSigningOrder.SEQUENTIAL) {
    return pending;
  }

  return pending.filter((recipient) => isRecipientTurnBySigningOrder(recipients, recipient));
};

const normaliseName = (name: string) => name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Whether the name the signer typed matches the recipient. A recipient without
 * a name accepts any name of two or more letters, and the typed name is recorded.
 */
export const isInPersonNameConfirmed = ({ expected, typed }: { expected: string; typed: string }) => {
  const typedName = normaliseName(typed);

  if (typedName.length < 2) {
    return false;
  }

  const expectedName = normaliseName(expected);

  if (!expectedName) {
    return true;
  }

  return typedName === expectedName;
};
