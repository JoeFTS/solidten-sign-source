import { RecipientRole, SigningStatus } from '@prisma/client';

import { AppError, AppErrorCode } from '../../errors/app-error';

type TRecipientState = {
  id: number;
  name: string;
  email: string;
  role: RecipientRole;
  signingStatus: SigningStatus;
};

const DONE_VERB: Record<RecipientRole, string> = {
  [RecipientRole.SIGNER]: 'signed',
  [RecipientRole.APPROVER]: 'approved',
  [RecipientRole.VIEWER]: 'viewed',
  [RecipientRole.ASSISTANT]: 'completed their part',
  [RecipientRole.CC]: 'received a copy',
};

/**
 * Solid Ten Sign (R-1): a recipient who has completed their part (signed, approved, viewed as a
 * viewer, or completed as an assistant). A CC is "signed" from the start and has nothing to
 * complete, so a CC is never counted.
 */
export const hasRecipientCompleted = (recipient: Pick<TRecipientState, 'role' | 'signingStatus'>) =>
  recipient.role !== RecipientRole.CC && recipient.signingStatus === SigningStatus.SIGNED;

const nameOf = (recipient: TRecipientState) =>
  recipient.name && recipient.name !== recipient.email ? `${recipient.name} (${recipient.email})` : recipient.email;

/**
 * Solid Ten Sign (R-1): the one check every recipient save passes (set, update and delete; web,
 * API v1 and v2, embedding, admin). A recipient who has completed their part cannot be removed,
 * and their email and role cannot be changed: their signature and the audit trail belong to that
 * person in that role. 400 with a plain message that names the person.
 *
 * `change` is "remove", or the email and role the save would store.
 */
export const assertRecipientChangeAllowed = (
  recipient: TRecipientState,
  change: 'remove' | { email?: string | null; role?: RecipientRole | null },
) => {
  if (!hasRecipientCompleted(recipient)) {
    return;
  }

  const verb = DONE_VERB[recipient.role];

  if (change === 'remove') {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: `${nameOf(recipient)} has already ${verb} and cannot be removed.`,
      statusCode: 400,
    });
  }

  const isEmailChanged = Boolean(change.email) && change.email!.toLowerCase() !== recipient.email.toLowerCase();
  const isRoleChanged = Boolean(change.role) && change.role !== recipient.role;

  if (isEmailChanged || isRoleChanged) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: `${nameOf(recipient)} has already ${verb}, so their email and role cannot be changed.`,
      statusCode: 400,
    });
  }
};

/**
 * Solid Ten Sign (R-3): whether a saved recipient keeps its send and signing status.
 * - Nothing about who or what they are changes: keep it (a name or auth edit is not a new send).
 * - A new email: reset; the email change hands the request to the new address and sends it.
 * - A new role between signer, approver, viewer and assistant: keep it. These roles all use the
 *   same signing link the recipient already got, so a "not sent" mark without a new email would
 *   only be wrong (before: NOT_SENT and no email).
 * - To or from CC: reset (a CC gets no signing link; a former CC never got one).
 */
export const keepsRecipientStatus = (
  previous: { email: string; role: RecipientRole },
  next: { email: string; role: RecipientRole },
) => {
  if (previous.email.toLowerCase() !== next.email.toLowerCase()) {
    return false;
  }

  if (previous.role === next.role) {
    return true;
  }

  return previous.role !== RecipientRole.CC && next.role !== RecipientRole.CC;
};
