import { prisma } from '@documenso/prisma';
import { DocumentStatus, EnvelopeType, SigningStatus } from '@prisma/client';
import { AppError, AppErrorCode } from '../../errors/app-error';
import type { ApiRequestMetadata, RequestMetadata } from '../../universal/extract-request-metadata';
import { extractDocumentAuthMethods } from '../../utils/document-auth';
import {
  getRecipientReassignBlockReason,
  isReassignEmailTaken,
  RECIPIENT_REASSIGN_BLOCK_MESSAGES,
} from '../../utils/recipient-reassign';
import { isRecipientEmailValidForSending } from '../../utils/recipients';
import { sanitizeSingleLineText } from '../../utils/safe-text';
import { assertActionAuthActorIsRecipient } from '../document/assert-completion-actor';
import { isRecipientAuthorized } from '../document/is-recipient-authorized';
import { lockEnvelopeForRecipientChange } from '../envelope/envelope-transition-lock';
import { deleteStoredFieldFiles, type StoredFieldFile } from '../field-file/remove-field-files-in-transaction';
import { getTeamSettings } from '../team/get-team-settings';
import { notifyRecipientReassigned } from './notify-recipient-reassigned';
import {
  applyRecipientHandoverInTransaction,
  buildRecipientHandoverData,
  HANDOVER_EMAIL_TAKEN_MESSAGE,
  resolveHandoverPhone,
} from './recipient-handover';

export type ReassignRecipientActor =
  | {
      type: 'SIGNER';
      /** The link token the signer presented. */
      token: string;
      /** The signed-in user, if any. Needed when the recipient must sign in to an account. */
      userId?: number;
      requestMetadata?: RequestMetadata;
    }
  | {
      type: 'SENDER';
      userId: number;
      /** An envelope the sender may see, already checked by the caller. */
      envelopeId: string;
      recipientId: number;
      metadata: ApiRequestMetadata;
    };

export type ReassignRecipientOptions = {
  actor: ReassignRecipientActor;
  name: string;
  email: string;
  reason?: string | null;
  /**
   * The new person's mobile number. Without one the recipient has no phone after the
   * handover and the new person is reached by email.
   */
  phoneNumber?: string | null;
};

const loadRecipient = async (actor: ReassignRecipientActor) => {
  const where =
    actor.type === 'SIGNER'
      ? { token: actor.token, envelope: { type: EnvelopeType.DOCUMENT } }
      : { id: actor.recipientId, envelopeId: actor.envelopeId, envelope: { type: EnvelopeType.DOCUMENT } };

  return await prisma.recipient.findFirst({
    where,
    include: {
      envelope: {
        include: {
          recipients: true,
          documentMeta: true,
        },
      },
      fields: true,
    },
  });
};

/**
 * Hand a recipient's signing request to another person.
 *
 * The recipient row is kept (its id, role, signing order and auth rules stay),
 * but it gets a new link token so the old link stops working at once, the old
 * person's field values and signatures are removed, and read status, expiry
 * and reminders start over for the new person.
 */
export const reassignRecipient = async ({
  actor,
  name,
  email,
  reason = null,
  phoneNumber,
}: ReassignRecipientOptions) => {
  const recipient = await loadRecipient(actor);

  if (!recipient) {
    throw new AppError(AppErrorCode.NOT_FOUND, {
      // Solid Ten Sign (RT3-L4): a sender asks by recipient id, a signer by link.
      message: actor.type === 'SIGNER' ? 'This signing link is no longer valid.' : 'Recipient not found',
    });
  }

  const { envelope } = recipient;

  const newEmail = email.trim().toLowerCase();
  // Solid Ten Sign (SEC2-L2): the same cleaning as the request schema, for every caller.
  const newName = sanitizeSingleLineText(name);

  const settings = await getTeamSettings({ teamId: envelope.teamId });

  const { derivedRecipientAccessAuth } = extractDocumentAuthMethods({
    documentAuth: envelope.authOptions,
    recipientAuth: recipient.authOptions,
  });

  const blockReason = getRecipientReassignBlockReason({
    actor: actor.type,
    envelope,
    recipient,
    settings,
    accessAuthMethods: derivedRecipientAccessAuth,
    now: new Date(),
  });

  if (blockReason) {
    throw new AppError(
      blockReason === 'NOT_ALLOWED_BY_SETTINGS' ? AppErrorCode.FORBIDDEN : AppErrorCode.INVALID_REQUEST,
      {
        message: RECIPIENT_REASSIGN_BLOCK_MESSAGES[blockReason],
      },
    );
  }

  if (actor.type === 'SIGNER') {
    // A recipient behind an account check proves who they are by being signed in.
    const isAuthorized = await isRecipientAuthorized({
      type: 'ACCESS',
      documentAuthOptions: envelope.authOptions,
      recipient,
      userId: actor.userId,
    });

    if (!isAuthorized) {
      throw new AppError(AppErrorCode.UNAUTHORIZED, {
        message: 'Sign in to the account this document was sent to before you reassign it.',
      });
    }

    // Solid Ten Sign (AUD-C11 follow-up, F3): with action auth, only the recipient's own session
    // passes the slot on, as for completing, un-signing and declining.
    await assertActionAuthActorIsRecipient({ documentAuth: envelope.authOptions, recipient, userId: actor.userId });
  }

  if (!isRecipientEmailValidForSending({ email: newEmail })) {
    throw new AppError(AppErrorCode.INVALID_BODY, {
      message: 'Enter a valid email address.',
    });
  }

  if (isReassignEmailTaken({ recipients: envelope.recipients, newEmail })) {
    throw new AppError(AppErrorCode.ALREADY_EXISTS, {
      message: HANDOVER_EMAIL_TAKEN_MESSAGE,
    });
  }

  const newPhone = await resolveHandoverPhone({ phoneNumber, envelope });

  const auditUser =
    actor.type === 'SIGNER'
      ? { name: recipient.name, email: recipient.email }
      : (actor.metadata.auditUser ?? { id: actor.userId });

  const removedFieldFiles: StoredFieldFile[] = [];

  await prisma.$transaction(async (tx) => {
    // Solid Ten Sign (FS2-C1): the envelope lock first, like every other recipient change.
    await lockEnvelopeForRecipientChange(tx, envelope.id);

    // The guard is part of the write: if the old person signs, rejects or is
    // reassigned by someone else in the meantime, nothing changes here.
    const { count } = await tx.recipient.updateMany({
      where: {
        id: recipient.id,
        token: recipient.token,
        signingStatus: SigningStatus.NOT_SIGNED,
        envelope: { status: DocumentStatus.PENDING },
      },
      data: {
        name: newName,
        email: newEmail,
        ...buildRecipientHandoverData({
          previousExpiresAt: recipient.expiresAt,
          envelopeExpirationPeriod: envelope.documentMeta?.envelopeExpirationPeriod,
        }),
      },
    });

    if (count !== 1) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: 'This request changed while you were reassigning it. Reload and try again.',
      });
    }

    await applyRecipientHandoverInTransaction(tx, {
      envelopeId: envelope.id,
      internalVersion: envelope.internalVersion,
      recipient,
      toName: newName,
      toEmail: newEmail,
      newPhone,
      reason,
      reassignedBy: actor.type,
      trigger: 'REASSIGN',
      auditUser,
      requestMetadata: actor.type === 'SIGNER' ? actor.requestMetadata : undefined,
      metadata: actor.type === 'SENDER' ? actor.metadata : undefined,
      removedFiles: removedFieldFiles,
    });
  });

  await deleteStoredFieldFiles(removedFieldFiles);

  await notifyRecipientReassigned({
    envelopeId: envelope.id,
    recipientId: recipient.id,
    previous: { email: recipient.email, name: recipient.name, sendStatus: recipient.sendStatus },
    isSelfReassigned: actor.type === 'SIGNER',
    reason,
    requestMetadata: actor.type === 'SIGNER' ? actor.requestMetadata : actor.metadata.requestMetadata,
  });

  return {
    recipientId: recipient.id,
    name: newName,
    email: newEmail,
  };
};
