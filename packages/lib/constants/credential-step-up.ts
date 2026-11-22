/**
 * Solid Ten Sign (AUD-C10 follow-up): the error codes of the credential step-up, safe to import in
 * the browser so the settings dialogs can show the message. The server side is
 * `server-only/auth/credential-step-up.ts`.
 */
export const SIGN_IN_AGAIN_TO_CHANGE_SIGN_IN_CODE = 'SIGN_IN_AGAIN_TO_CHANGE_SIGN_IN';
export const SIGN_IN_AGAIN_TO_CHANGE_SIGN_IN_MESSAGE =
  'For your security, sign in again to change how you sign in. Then make the change within 10 minutes.';

export const TWO_FACTOR_CODE_REQUIRED_TO_CHANGE_SIGN_IN_CODE = 'TWO_FACTOR_CODE_REQUIRED_TO_CHANGE_SIGN_IN';
export const TWO_FACTOR_CODE_REQUIRED_TO_CHANGE_SIGN_IN_MESSAGE =
  'Enter a valid code from your authenticator app to make this change.';
