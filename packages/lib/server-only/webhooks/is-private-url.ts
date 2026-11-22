import { isIpAddressLiteral, isPublicUnicastIp } from './ip-classification';

/**
 * Synchronously check whether a URL's host is a known private/loopback address
 * (localhost, RFC 1918, link-local, loopback, etc.), regardless of protocol.
 *
 * IP literals are refused unless they are public unicast. Hostnames other than
 * localhost return `false` here; their DNS answers are checked by
 * `assertNotPrivateUrl`. See there for the full SSRF caveats.
 */
export const isPrivateUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();

    // Strip IPv6 brackets.
    const bare = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
    const normalizedHost = bare.replace(/\.+$/, '');

    if (normalizedHost === 'localhost') {
      return true;
    }

    // Solid Ten Sign (S-L4): an IP literal must be public unicast (see ip-classification.ts).
    // `new URL()` has already turned other IPv4 spellings (2130706433, 127.1, 0x7f.1) into
    // dotted form.
    if (isIpAddressLiteral(normalizedHost)) {
      return !isPublicUnicastIp(normalizedHost);
    }

    return false;
  } catch {
    return false;
  }
};
