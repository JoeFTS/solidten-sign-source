import { prisma } from '@documenso/prisma';
import { DocumentStatus, SigningStatus } from '@prisma/client';

import { AppError, AppErrorCode } from '../../errors/app-error';
import type { ApiRequestMetadata } from '../../universal/extract-request-metadata';
import { lockEnvelopeForRecipientChange } from '../envelope/envelope-transition-lock';
import { deleteStoredFieldFiles, type StoredFieldFile } from '../field-file/remove-field-files-in-transaction';
import { notifyRecipientReassigned } from './notify-recipient-reassigned';
import {
  applyRecipientHandoverInTransaction,
  buildRecipientHandoverData,
  type THandoverPhone,
} from './recipient-handover';

/**
 * A sender changing or removing the phone number of a recipient on a sent document.
 *
 * The old number may hold a texted link, and whoever has that phone is not
 * necessarily the recipient any more, so this is a handover: a new link (the old
 * one stops working), the recipient's fields cleared, the number replaced, an
 * audit entry, and the new link sent to the new number (or by email when the
 * number was removed). The old number receives nothing further.
 */
export const handoverRecipientPhone = async ({
  envelopeId,
  recipientId,
  newPhone,
  metadata,
}: {
  envelopeId: string;
  recipientId: number;
  newPhone: THandoverPhone | null;
  metadata?: ApiRequestMetadata;
}) => {
  const recipient = await prisma.recipient.findFirstOrThrow({
    where: { id: recipientId, envelopeId },
    include: { envelope: { include: { documentMeta: true } } },
  });

  const removedFiles: StoredFieldFile[] = [];

  await prisma.$transaction(async (tx) => {
    // Solid Ten Sign (FS2-C1): the envelope lock first, like every other recipient change.
    await lockEnvelopeForRecipientChange(tx, envelopeId);

    const { count } = await tx.recipient.updateMany({
      where: {
        id: recipient.id,
        token: recipient.token,
        signingStatus: SigningStatus.NOT_SIGNED,
        envelope: { status: DocumentStatus.PENDING },
      },
      data: buildRecipientHandoverData({
        previousExpiresAt: recipient.expiresAt,
        envelopeExpirationPeriod: recipient.envelope.documentMeta?.envelopeExpirationPeriod,
      }),
    });

    if (count !== 1) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: 'This recipient changed while you were editing it. Reload and try again.',
      });
    }

    await applyRecipientHandoverInTransaction(tx, {
      envelopeId,
      internalVersion: recipient.envelope.internalVersion,
      recipient,
      toName: recipient.name,
      toEmail: recipient.email,
      newPhone,
      reassignedBy: 'SENDER',
      trigger: 'PHONE_CHANGE',
      metadata,
      removedFiles,
    });
  });

  await deleteStoredFieldFiles(removedFiles);

  // Same person, so no "passed to someone else" notice to their email.
  await notifyRecipientReassigned({
    envelopeId,
    recipientId,
    previous: { email: recipient.email, name: recipient.name, sendStatus: recipient.sendStatus },
    isSelfReassigned: false,
    requestMetadata: metadata?.requestMetadata,
    shouldNotifyPrevious: false,
  });
};
