import { DocumentStatus, EnvelopeType } from '@prisma/client';

import { assertHandoverEmailAvailable } from '../recipient-reassign/recipient-handover';

/**
 * Solid Ten Sign (RT2-L1): on a sent document, a NEW recipient cannot take an email that
 * another recipient already has, the same rule every handover path applies. Drafts keep
 * upstream behaviour.
 *
 * `resulting` is every recipient the envelope will have, new rows included; new rows have
 * no id (or an id no existing recipient has).
 */
export const assertNewRecipientEmailsAvailable = ({
  envelope,
  existingIds,
  resulting,
}: {
  envelope: { type: EnvelopeType; status: DocumentStatus };
  existingIds: number[];
  resulting: { id?: number | null; email: string }[];
}) => {
  if (envelope.type !== EnvelopeType.DOCUMENT || envelope.status !== DocumentStatus.PENDING) {
    return;
  }

  resulting.forEach((recipient, index) => {
    if (recipient.id && existingIds.includes(recipient.id)) {
      return;
    }

    // A placeholder id that no other row has, so the row is compared with every other one.
    const placeholderId = -1 - index;

    assertHandoverEmailAvailable({
      recipients: resulting.map((other, otherIndex) => ({
        id: otherIndex === index ? placeholderId : (other.id ?? -1000 - otherIndex),
        email: other.email,
      })),
      recipientId: placeholderId,
      newEmail: recipient.email,
    });
  });
};
