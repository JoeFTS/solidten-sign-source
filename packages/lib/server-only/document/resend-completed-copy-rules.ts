import { DocumentStatus } from '@prisma/client';

import { UNVERIFIED_RECIPIENT_EMAIL_MESSAGE } from '../../utils/recipient-mail';
import { isRecipientEmailValidForSending } from '../../utils/recipients';

export const RESEND_COPY_NOT_COMPLETED_MESSAGE = 'Only a completed document has a signed copy to send.';
export const RESEND_COPY_NO_ADDRESS_MESSAGE = 'This recipient has no email address the signed copy can be sent to.';
export const RESEND_COPY_SETTINGS_OFF_MESSAGE =
  'The email settings of this document do not send the signed copy to recipients.';

/**
 * Solid Ten Sign: why a "Resend signed copy" to this recipient is refused, or null when it may go
 * ahead. Pure, so the order and the messages are unit tested; resend-completed-copy.ts supplies
 * the facts (and refuses an unknown recipient before this).
 */
export const getResendCompletedCopyRefusal = ({
  status,
  recipient,
  isCopyEnabledForRecipient,
}: {
  status: DocumentStatus;
  recipient: { email: string; unverifiedEmailAt: Date | null };
  /** The document's "document completed" email setting, or a signer hosted in person. */
  isCopyEnabledForRecipient: boolean;
}): string | null => {
  if (status !== DocumentStatus.COMPLETED) {
    return RESEND_COPY_NOT_COMPLETED_MESSAGE;
  }

  // Same rule and message as resend (web app and API v1): no mail to an address a visitor typed.
  if (recipient.unverifiedEmailAt) {
    return UNVERIFIED_RECIPIENT_EMAIL_MESSAGE;
  }

  if (!isRecipientEmailValidForSending(recipient)) {
    return RESEND_COPY_NO_ADDRESS_MESSAGE;
  }

  if (!isCopyEnabledForRecipient) {
    return RESEND_COPY_SETTINGS_OFF_MESSAGE;
  }

  return null;
};
