import { msg } from '@lingui/core/macro';

import {
  SIGN_IN_AGAIN_TO_CHANGE_SIGN_IN_CODE,
  TWO_FACTOR_CODE_REQUIRED_TO_CHANGE_SIGN_IN_CODE,
} from './credential-step-up';

/** Solid Ten Sign (AUD-C10 follow-up): what the settings dialogs show for a step-up refusal. */
export const CREDENTIAL_STEP_UP_MESSAGES = {
  [SIGN_IN_AGAIN_TO_CHANGE_SIGN_IN_CODE]: msg`For your security, sign in again to change how you sign in. Then make the change within 10 minutes.`,
  [TWO_FACTOR_CODE_REQUIRED_TO_CHANGE_SIGN_IN_CODE]: msg`Enter a valid code from your authenticator app to make this change.`,
} as const;

/** The step-up message for an error, or null when the error is not a step-up refusal. */
export const getCredentialStepUpMessage = (code: string | undefined) =>
  code && code in CREDENTIAL_STEP_UP_MESSAGES
    ? CREDENTIAL_STEP_UP_MESSAGES[code as keyof typeof CREDENTIAL_STEP_UP_MESSAGES]
    : null;
