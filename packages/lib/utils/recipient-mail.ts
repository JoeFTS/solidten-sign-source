import { isRecipientEmailValidForSending } from './recipients';

/**
 * Solid Ten Sign (AUD-C4 follow-up): whether the server may send mail to this recipient's address.
 *
 * A visitor on a direct link who did not prove the address they typed (no public-form code, no
 * session with that email) gets a recipient row with `unverifiedEmailAt` set. Their signing
 * counts, but no mail goes to that address. Every other recipient of the document, and every
 * owner notice, is not affected. `unverifiedEmailAt` is cleared when the sender changes the
 * recipient's email.
 */
export const canSendMailToRecipient = (recipient: { email: string; unverifiedEmailAt: Date | null }) =>
  !recipient.unverifiedEmailAt && isRecipientEmailValidForSending(recipient);

export const UNVERIFIED_RECIPIENT_EMAIL_MESSAGE =
  'This address was typed by a visitor on a direct link and is not verified, so Solid Ten Sign does not send mail to it.';
