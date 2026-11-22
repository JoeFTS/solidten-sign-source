import { prisma } from '@documenso/prisma';
import type { Prisma, Recipient } from '@prisma/client';
import { DocumentStatus, EnvelopeType, RecipientRole } from '@prisma/client';
import type { ApiRequestMetadata } from '../../universal/extract-request-metadata';
import { deleteStoredFieldFiles, type StoredFieldFile } from '../field-file/remove-field-files-in-transaction';
import { notifyRecipientReassigned } from './notify-recipient-reassigned';
import {
  applyRecipientHandoverInTransaction,
  assertHandoverEmailAvailable,
  buildRecipientHandoverData,
} from './recipient-handover';

type EmailChange = {
  previous: Recipient;
  newEmail: string;
};

/**
 * Makes a sender's email change on a recipient of a sent document behave like a
 * reassignment. Without it the recipient keeps its token, so the link already
 * emailed to the old address keeps working and signs as the new person.
 *
 * Used by the sender's recipient edit paths (updateEnvelopeRecipients and
 * setDocumentRecipients) in three steps around their own transaction:
 * `resetDataFor` goes into the recipient update, `recordAudit` clears the old
 * person's fields and writes the audit entry inside the transaction, and
 * `notify` runs after it commits. These are the same steps reassignRecipient takes. A name-only change is not an
 * email change and keeps the token.
 */
export const prepareRecipientEmailChanges = async ({
  envelope,
  changes,
  resultingRecipients,
}: {
  envelope: { id: string; type: EnvelopeType; status: DocumentStatus; internalVersion: number };
  changes: EmailChange[];
  /** Every recipient as it will be after the edit, to refuse an email another one already has. */
  resultingRecipients: { id?: number | null; email: string }[];
}) => {
  const isSentDocument = envelope.type === EnvelopeType.DOCUMENT && envelope.status === DocumentStatus.PENDING;

  const emailChanges = isSentDocument
    ? changes.filter(
        ({ previous, newEmail }) =>
          previous.role !== RecipientRole.CC && previous.email.toLowerCase() !== newEmail.trim().toLowerCase(),
      )
    : [];

  for (const { previous, newEmail } of emailChanges) {
    assertHandoverEmailAvailable({ recipients: resultingRecipients, recipientId: previous.id, newEmail });
  }

  const meta =
    emailChanges.length > 0
      ? await prisma.envelope.findUniqueOrThrow({
          where: { id: envelope.id },
          select: { documentMeta: { select: { envelopeExpirationPeriod: true } } },
        })
      : null;

  const byRecipientId = new Map(emailChanges.map((change) => [change.previous.id, change]));

  const removedFiles: StoredFieldFile[] = [];

  return {
    resetDataFor: (recipientId: number | undefined) => {
      const change = recipientId === undefined ? undefined : byRecipientId.get(recipientId);

      if (!change) {
        return {};
      }

      return buildRecipientHandoverData({
        previousExpiresAt: change.previous.expiresAt,
        envelopeExpirationPeriod: meta?.documentMeta?.envelopeExpirationPeriod,
      });
    },

    recordAudit: async (
      tx: Prisma.TransactionClient,
      updated: Pick<Recipient, 'id' | 'name' | 'email'>,
      metadata: ApiRequestMetadata,
    ) => {
      const change = byRecipientId.get(updated.id);

      if (!change) {
        return;
      }

      await applyRecipientHandoverInTransaction(tx, {
        envelopeId: envelope.id,
        internalVersion: envelope.internalVersion,
        recipient: change.previous,
        toName: updated.name,
        toEmail: updated.email,
        newPhone: null,
        reassignedBy: 'SENDER',
        trigger: 'EMAIL_CHANGE',
        metadata,
        removedFiles,
      });
    },

    notify: async (metadata: ApiRequestMetadata) => {
      // Runs after the transaction commits.
      await deleteStoredFieldFiles(removedFiles.splice(0));

      for (const { previous } of emailChanges) {
        await notifyRecipientReassigned({
          envelopeId: envelope.id,
          recipientId: previous.id,
          previous: { email: previous.email, name: previous.name, sendStatus: previous.sendStatus },
          isSelfReassigned: false,
          requestMetadata: metadata.requestMetadata,
        });
      }
    },
  };
};
