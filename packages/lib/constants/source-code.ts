import { env } from '../utils/env';

/**
 * Solid Ten Sign: where the source code of this service is published (AGPL-3.0, section 13: every
 * user who uses the service over a network must be offered the source).
 */
export const DEFAULT_SOURCE_CODE_URL = 'https://github.com/JoeFTS/solidten-sign-source';

/** The value if it is an absolute http(s) URL, else the default. */
export const resolveSourceCodeUrl = (value: string | undefined | null) => {
  const candidate = value?.trim();

  if (!candidate) {
    return DEFAULT_SOURCE_CODE_URL;
  }

  try {
    const url = new URL(candidate);

    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return DEFAULT_SOURCE_CODE_URL;
    }

    return url.toString();
  } catch {
    return DEFAULT_SOURCE_CODE_URL;
  }
};

/** The source code link (NEXT_PUBLIC_ST_SOURCE_URL, http or https only). Works on server and client. */
export const NEXT_PUBLIC_ST_SOURCE_URL = () => resolveSourceCodeUrl(env('NEXT_PUBLIC_ST_SOURCE_URL'));
