/**
 * Solid Ten Sign (F-6): whether anyone can create an account on this server.
 *
 * The same rule as the sign-in page: e-mail sign-up, or a configured Google, Microsoft or OIDC
 * provider whose sign-up is not turned off; NEXT_PUBLIC_DISABLE_SIGNUP turns all of it off. The
 * provider settings are private, so the server computes this and passes it to the browser as
 * NEXT_PUBLIC_ST_SIGNUP_AVAILABLE (createPublicEnv).
 *
 * This file reads its environment itself (no import of env.ts, which imports it).
 */
type TEnvSource = Record<string, string | undefined>;

export const computeSignupAvailable = (source: TEnvSource): boolean => {
  if (source.NEXT_PUBLIC_DISABLE_SIGNUP === 'true') {
    return false;
  }

  const isOn = (flag: string) => source[flag] !== 'true';

  const isGoogle = Boolean(source.NEXT_PRIVATE_GOOGLE_CLIENT_ID && source.NEXT_PRIVATE_GOOGLE_CLIENT_SECRET);
  const isMicrosoft = Boolean(source.NEXT_PRIVATE_MICROSOFT_CLIENT_ID && source.NEXT_PRIVATE_MICROSOFT_CLIENT_SECRET);
  const isOidc = Boolean(
    source.NEXT_PRIVATE_OIDC_WELL_KNOWN && source.NEXT_PRIVATE_OIDC_CLIENT_ID && source.NEXT_PRIVATE_OIDC_CLIENT_SECRET,
  );

  return (
    isOn('NEXT_PUBLIC_DISABLE_EMAIL_PASSWORD_SIGNUP') ||
    (isGoogle && isOn('NEXT_PUBLIC_DISABLE_GOOGLE_SIGNUP')) ||
    (isMicrosoft && isOn('NEXT_PUBLIC_DISABLE_MICROSOFT_SIGNUP')) ||
    (isOidc && isOn('NEXT_PUBLIC_DISABLE_OIDC_SIGNUP'))
  );
};

/** In the browser from the value the server passed; on the server from its own settings. */
export const isSignupAvailable = (): boolean => {
  const browserEnv = typeof window !== 'undefined' ? window.__ENV__ : undefined;
  const passed = browserEnv?.NEXT_PUBLIC_ST_SIGNUP_AVAILABLE;

  if (passed === 'true' || passed === 'false') {
    return passed === 'true';
  }

  return computeSignupAvailable(typeof process !== 'undefined' ? process.env : {});
};
