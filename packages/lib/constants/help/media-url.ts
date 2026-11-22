/**
 * Solid Ten Sign: the pure part of the help media settings. No imports on purpose: the server's
 * CSP code reaches this file while the dev config loads, where only plain Node resolves modules.
 */

/**
 * Solid Ten Sign: where the help videos live. They are not in git or in the image. In development
 * they sit in apps/remix/public/help-media/ (git-ignored); on the server the web server serves the
 * folder.
 */
export const DEFAULT_HELP_MEDIA_URL = '/help-media';

/**
 * The value if it is an absolute http(s) URL or a same-origin path that starts with one "/", else
 * the default. The result has no trailing slash.
 */
export const resolveHelpMediaUrl = (value: string | undefined | null) => {
  const candidate = value?.trim();

  if (!candidate) {
    return DEFAULT_HELP_MEDIA_URL;
  }

  // A same-origin path. "//host" is another origin and a backslash can be read as a slash.
  if (candidate.startsWith('/')) {
    if (candidate.startsWith('//') || candidate.includes('\\') || /[\s?#]/.test(candidate)) {
      return DEFAULT_HELP_MEDIA_URL;
    }

    return candidate.replace(/\/+$/, '') || DEFAULT_HELP_MEDIA_URL;
  }

  try {
    const url = new URL(candidate);

    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return DEFAULT_HELP_MEDIA_URL;
    }

    if (url.username || url.password || url.search || url.hash) {
      return DEFAULT_HELP_MEDIA_URL;
    }

    return url.toString().replace(/\/+$/, '');
  } catch {
    return DEFAULT_HELP_MEDIA_URL;
  }
};

/**
 * The CSP `media-src` sources: always 'self', plus the origin of the help media base when it is an
 * absolute http(s) URL. Nothing else in the app plays audio or video.
 */
export const getHelpMediaCspSources = (value: string | undefined | null) => {
  const base = resolveHelpMediaUrl(value);

  const sources = ["'self'"];

  if (!base.startsWith('/')) {
    try {
      sources.push(new URL(base).origin);
    } catch {
      // resolveHelpMediaUrl only returns paths and valid URLs.
    }
  }

  return sources.join(' ');
};
