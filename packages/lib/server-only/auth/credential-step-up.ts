import { prisma } from '@documenso/prisma';

import {
  SIGN_IN_AGAIN_TO_CHANGE_SIGN_IN_CODE,
  SIGN_IN_AGAIN_TO_CHANGE_SIGN_IN_MESSAGE,
  TWO_FACTOR_CODE_REQUIRED_TO_CHANGE_SIGN_IN_CODE,
  TWO_FACTOR_CODE_REQUIRED_TO_CHANGE_SIGN_IN_MESSAGE,
} from '../../constants/credential-step-up';
import { AppError } from '../../errors/app-error';
import { validateTwoFactorAuthentication } from '../2fa/validate-2fa';

/**
 * Solid Ten Sign (AUD-C10): adding a sign-in credential needs a fresh proof. A passkey signs in
 * on its own (no email link, no 2FA), so a stolen or left-open session must not be able to add
 * one.
 */
export const CREDENTIAL_STEP_UP_WINDOW_MS = 10 * 60 * 1000;

export const SIGN_IN_AGAIN_CODE = 'SIGN_IN_AGAIN_TO_ADD_PASSKEY';
export const SIGN_IN_AGAIN_MESSAGE =
  'For your security, sign in again to add a passkey. Then add it within 10 minutes.';

export const TWO_FACTOR_CODE_REQUIRED_CODE = 'TWO_FACTOR_CODE_REQUIRED_TO_ADD_PASSKEY';
export const TWO_FACTOR_CODE_REQUIRED_MESSAGE = 'Enter a valid code from your authenticator app to add a passkey.';

export const isSessionFreshForCredentialChange = (session: { createdAt: Date }, now = new Date()) => {
  const age = now.getTime() - session.createdAt.getTime();

  return age >= 0 && age <= CREDENTIAL_STEP_UP_WINDOW_MS;
};

type StepUpSession = { createdAt: Date; isEmbed?: boolean; stInPersonSessionId?: string | null };

type StepUpError = { code: string; message: string };

const PASSKEY_SIGN_IN_AGAIN: StepUpError = { code: SIGN_IN_AGAIN_CODE, message: SIGN_IN_AGAIN_MESSAGE };

export const CHANGE_SIGN_IN_AGAIN: StepUpError = {
  code: SIGN_IN_AGAIN_TO_CHANGE_SIGN_IN_CODE,
  message: SIGN_IN_AGAIN_TO_CHANGE_SIGN_IN_MESSAGE,
};

export const CHANGE_TWO_FACTOR_CODE_REQUIRED: StepUpError = {
  code: TWO_FACTOR_CODE_REQUIRED_TO_CHANGE_SIGN_IN_CODE,
  message: TWO_FACTOR_CODE_REQUIRED_TO_CHANGE_SIGN_IN_MESSAGE,
};

/**
 * No sign-in session (an API token), an embed sign-in, or a device locked to in-person signing is
 * never fresh: a credential is changed from the user's own signed-in browser.
 */
export const assertSessionFreshForCredentialChange = (
  session: StepUpSession | null,
  now = new Date(),
  error: StepUpError = PASSKEY_SIGN_IN_AGAIN,
) => {
  if (!session || session.isEmbed || session.stInPersonSessionId || !isSessionFreshForCredentialChange(session, now)) {
    throw new AppError(error.code, {
      message: error.message,
      userMessage: error.message,
      statusCode: 401,
    });
  }
};

/**
 * When the account has 2FA on, a valid authenticator code (or a backup code, which is used up)
 * is required. Accounts without 2FA pass.
 */
export const assertTwoFactorForCredentialChange = async ({
  userId,
  twoFactorCode,
  error = { code: TWO_FACTOR_CODE_REQUIRED_CODE, message: TWO_FACTOR_CODE_REQUIRED_MESSAGE },
}: {
  userId: number;
  twoFactorCode?: string | null;
  error?: StepUpError;
}) => {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { id: true, email: true, twoFactorEnabled: true, twoFactorSecret: true, twoFactorBackupCodes: true },
  });

  if (!user.twoFactorEnabled) {
    return;
  }

  const code = twoFactorCode?.trim() ?? '';

  const isValid = code
    ? await validateTwoFactorAuthentication({
        user,
        // Six digits is an authenticator code; anything else is tried as a backup code.
        ...(/^\d{6}$/.test(code) ? { totpCode: code } : { backupCode: code }),
      }).catch(() => false)
    : false;

  if (!isValid) {
    throw new AppError(error.code, {
      message: error.message,
      userMessage: error.message,
      statusCode: 400,
    });
  }
};

/**
 * Solid Ten Sign (AUD-C10 follow-up): every other credential change (2FA setup, enable and
 * disable, backup codes, passkey rename and delete, password change) needs the same step-up as
 * adding a passkey: a sign-in from the last 10 minutes in the user's own browser, and the current
 * 2FA code when 2FA is on and the route does not already check it (`checkTwoFactor`).
 */
export const assertCredentialChangeStepUp = async ({
  session,
  userId,
  twoFactorCode,
  checkTwoFactor,
}: {
  session: StepUpSession | null;
  userId: number;
  twoFactorCode?: string | null;
  checkTwoFactor: boolean;
}) => {
  assertSessionFreshForCredentialChange(session, new Date(), CHANGE_SIGN_IN_AGAIN);

  if (checkTwoFactor) {
    await assertTwoFactorForCredentialChange({ userId, twoFactorCode, error: CHANGE_TWO_FACTOR_CODE_REQUIRED });
  }
};

/**
 * After a passkey is added or removed, or 2FA is turned on or off, every other sign-in of the
 * user ends. The current one stays (none stays when the change came without a sign-in).
 */
export const revokeOtherUserSessions = async ({
  userId,
  currentSessionId,
}: {
  userId: number;
  currentSessionId: string | null | undefined;
}) => {
  await prisma.session.deleteMany({
    where: { userId, ...(currentSessionId ? { id: { not: currentSessionId } } : {}) },
  });
};
