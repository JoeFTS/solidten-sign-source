import { DocumentStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { UNVERIFIED_RECIPIENT_EMAIL_MESSAGE } from '../../utils/recipient-mail';
import {
  getResendCompletedCopyRefusal,
  RESEND_COPY_NO_ADDRESS_MESSAGE,
  RESEND_COPY_NOT_COMPLETED_MESSAGE,
  RESEND_COPY_SETTINGS_OFF_MESSAGE,
} from './resend-completed-copy-rules';

const recipient = { email: 'signer@example.com', unverifiedEmailAt: null };

describe('Resend signed copy: who may get it again', () => {
  it('a verified recipient of a completed document with the copy email on', () => {
    expect(
      getResendCompletedCopyRefusal({ status: DocumentStatus.COMPLETED, recipient, isCopyEnabledForRecipient: true }),
    ).toBeNull();
  });

  it.each([
    DocumentStatus.DRAFT,
    DocumentStatus.PENDING,
    DocumentStatus.REJECTED,
  ])('refuses a document that is %s', (status) => {
    expect(getResendCompletedCopyRefusal({ status, recipient, isCopyEnabledForRecipient: true })).toBe(
      RESEND_COPY_NOT_COMPLETED_MESSAGE,
    );
  });

  it('refuses an address a visitor typed on a direct link, with the resend message', () => {
    expect(
      getResendCompletedCopyRefusal({
        status: DocumentStatus.COMPLETED,
        recipient: { ...recipient, unverifiedEmailAt: new Date() },
        isCopyEnabledForRecipient: true,
      }),
    ).toBe(UNVERIFIED_RECIPIENT_EMAIL_MESSAGE);
  });

  it('refuses a recipient without a valid address', () => {
    expect(
      getResendCompletedCopyRefusal({
        status: DocumentStatus.COMPLETED,
        recipient: { email: '', unverifiedEmailAt: null },
        isCopyEnabledForRecipient: true,
      }),
    ).toBe(RESEND_COPY_NO_ADDRESS_MESSAGE);
  });

  it("refuses when the document's email settings do not send the copy", () => {
    expect(
      getResendCompletedCopyRefusal({ status: DocumentStatus.COMPLETED, recipient, isCopyEnabledForRecipient: false }),
    ).toBe(RESEND_COPY_SETTINGS_OFF_MESSAGE);
  });
});
