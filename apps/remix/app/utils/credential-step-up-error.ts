import { getCredentialStepUpMessage } from '@documenso/lib/constants/credential-step-up-messages';
import { AppError } from '@documenso/lib/errors/app-error';
import type { MessageDescriptor } from '@lingui/core';

/**
 * Solid Ten Sign (AUD-C10 follow-up): the message for a credential change the server refused
 * because the sign-in is too old (or the 2FA code is missing), or null for any other error.
 */
export const getCredentialStepUpError = (err: unknown): MessageDescriptor | null =>
  getCredentialStepUpMessage(AppError.parseError(err).code);
