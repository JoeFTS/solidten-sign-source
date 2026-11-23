/**
 * Solid Ten Sign (M): whether this server offers email-and-password sign-in.
 *
 * NEXT_PUBLIC_DISABLE_EMAIL_PASSWORD_SIGNIN=true (or the kill switch NEXT_PUBLIC_DISABLE_SIGNIN=true)
 * turns it off. Then nobody can use a password, so no screen, email or route may offer to set,
 * change or reset one. The same rule as isSigninEnabledForProvider('email').
 *
 * Both values are public, so the browser reads them from window.__ENV__ and the server from its
 * own environment. This file reads them itself (no import of env.ts, which imports
 * signup-availability.ts, which imports this file).
 */
type TEnvSource = Record<string, string | undefined>;

export const computePasswordSigninAvailable = (source: TEnvSource): boolean => {
  return source.NEXT_PUBLIC_DISABLE_SIGNIN !== 'true' && source.NEXT_PUBLIC_DISABLE_EMAIL_PASSWORD_SIGNIN !== 'true';
};

/**
 * Email-and-password sign-up makes an account with a password. When password sign-in is off,
 * that password could never be used, so this sign-up is off too.
 */
export const computePasswordSignupAvailable = (source: TEnvSource): boolean => {
  return (
    source.NEXT_PUBLIC_DISABLE_SIGNUP !== 'true' &&
    source.NEXT_PUBLIC_DISABLE_EMAIL_PASSWORD_SIGNUP !== 'true' &&
    source.NEXT_PUBLIC_DISABLE_EMAIL_PASSWORD_SIGNIN !== 'true'
  );
};

const readEnvSource = (): TEnvSource => {
  if (typeof window !== 'undefined' && typeof window.__ENV__ === 'object') {
    return window.__ENV__;
  }

  return typeof process !== 'undefined' ? process.env : {};
};

/** In the browser from the values the server passed; on the server from its own settings. */
export const isPasswordSigninAvailable = (): boolean => computePasswordSigninAvailable(readEnvSource());

export const isPasswordSignupAvailable = (): boolean => computePasswordSignupAvailable(readEnvSource());

/**
 * Solid Ten Sign (O-F7): a "Require password" stored earlier that this server can no longer
 * honour. The editor shows it, also without the plan flag that normally shows the action-auth
 * selects, so a sender can take it off.
 */
export const isStalePasswordActionAuth = (value: readonly (string | null | undefined)[] | null | undefined): boolean =>
  !isPasswordSigninAvailable() && Boolean(value?.includes('PASSWORD'));
