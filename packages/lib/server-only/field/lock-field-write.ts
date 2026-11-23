import { plainRefusal } from '@documenso/lib/errors/plain-refusal';
import type { Prisma } from '@prisma/client';
import { SigningStatus } from '@prisma/client';
import { AppError, AppErrorCode } from '../../errors/app-error';
import type { RequestMetadata } from '../../universal/extract-request-metadata';
import { fieldsContainUnsignedRequiredVisibleField } from '../../utils/field-conditions';
import {
  assertEnvelopeOpenForRecipientAction,
  lockPendingEnvelope,
  RECIPIENT_ALREADY_ACTED_MESSAGE,
} from '../envelope/envelope-transition-lock';
import { applyFieldLogic } from '../field-logic/apply-field-logic';

/**
 * Solid Ten Sign (AUD-C2): a field write by link token (insert or uninsert) runs under the
 * envelope transition lock, the same lock a completion, decline, cancel or delete takes.
 *
 * Under the lock it re-checks that the envelope is still pending and open, and that both the
 * acting recipient and the field's owner are still NOT_SIGNED. A field of a recipient who has
 * completed (or declined) can then never change, and a race between a field write and a
 * completion has one clean winner.
 */
export const lockEnvelopeForFieldWrite = async (
  tx: Prisma.TransactionClient,
  { envelopeId, recipientIds }: { envelopeId: string; recipientIds: number[] },
) => {
  await lockPendingEnvelope(tx, envelopeId);

  await assertEnvelopeOpenForRecipientAction(tx, envelopeId, recipientIds[0]);

  const recipients = await tx.recipient.findMany({
    where: { envelopeId, id: { in: recipientIds } },
    select: { id: true, signingStatus: true },
  });

  const isOpen =
    recipients.length === new Set(recipientIds).size &&
    recipients.every((recipient) => recipient.signingStatus === SigningStatus.NOT_SIGNED);

  if (!isOpen) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: RECIPIENT_ALREADY_ACTED_MESSAGE,
      userMessage: RECIPIENT_ALREADY_ACTED_MESSAGE,
      statusCode: 400,
    });
  }
};

/**
 * Solid Ten Sign (AUD-C2): inside the completion's locked transaction, apply the field rules
 * and run the required-field check again on the fields as they are now. The check before the
 * lock can pass on a read made before a concurrent uninsert committed.
 */
export const assertRecipientFieldsCompleteUnderLock = async (
  tx: Prisma.TransactionClient,
  {
    envelopeId,
    recipientId,
    user,
    requestMetadata,
  }: {
    envelopeId: string;
    recipientId: number;
    user: { name: string; email: string };
    requestMetadata?: RequestMetadata;
  },
) => {
  await applyFieldLogic({ tx, envelopeId, recipientId, user, requestMetadata });

  const fields = await tx.field.findMany({ where: { envelopeId, recipientId } });

  if (fieldsContainUnsignedRequiredVisibleField(fields)) {
    throw plainRefusal(
      AppErrorCode.RECIPIENT_HAS_UNSIGNED_FIELDS,
      'Fill in every required field before you finish.',
      { recipientId, envelopeId },
      { statusCode: 400 },
    );
  }
};
