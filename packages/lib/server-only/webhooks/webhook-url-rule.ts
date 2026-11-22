import { AppError, AppErrorCode } from '../../errors/app-error';
import { env } from '../../utils/env';
import { isPrivateUrl } from './is-private-url';

/**
 * Browser-safe: no Node imports. The webhook form schema (shared by the dialogs and the tRPC
 * input) and the delivery code (assertNotPrivateUrl) both use these, so a host the operator put
 * in NEXT_PRIVATE_WEBHOOK_SSRF_BYPASS_HOSTS is accepted by the form and called by delivery,
 * and every other private host is refused by both.
 */

export const normalizeWebhookHostname = (hostname: string) => hostname.toLowerCase().replace(/\.+$/, '');

export const parseWebhookSsrfBypassHosts = (raw: string | undefined): Set<string> => {
  const hosts = new Set<string>();

  for (const entry of (raw ?? '').split(',')) {
    const trimmed = normalizeWebhookHostname(entry.trim());

    if (trimmed.length > 0) {
      hosts.add(trimmed);
    }
  }

  return hosts;
};

export const isHostInWebhookSsrfBypassList = (url: string, hosts: Set<string>): boolean => {
  if (hosts.size === 0) {
    return false;
  }

  try {
    const hostname = normalizeWebhookHostname(new URL(url).hostname);

    // URL.hostname keeps IPv6 brackets; operators write bare addresses.
    const bare = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;

    return hosts.has(hostname) || hosts.has(bare);
  } catch {
    return false;
  }
};

let serverBypassHosts: Set<string> | null = null;

/**
 * Read once, like the original module-load behaviour: changing the variable needs a restart.
 */
export const getServerWebhookSsrfBypassHosts = (): Set<string> => {
  if (serverBypassHosts === null) {
    serverBypassHosts = parseWebhookSsrfBypassHosts(
      typeof process !== 'undefined' ? process.env.NEXT_PRIVATE_WEBHOOK_SSRF_BYPASS_HOSTS : undefined,
    );
  }

  return serverBypassHosts;
};

export const isWebhookSsrfBypassedHost = (url: string) =>
  isHostInWebhookSsrfBypassList(url, getServerWebhookSsrfBypassHosts());

/**
 * The literal-URL rule. DNS resolution is checked again at delivery time by assertNotPrivateUrl.
 */
export const isWebhookUrlAllowed = (url: string, bypassHosts: Set<string>) =>
  isHostInWebhookSsrfBypassList(url, bypassHosts) || !isPrivateUrl(url);

export const WEBHOOK_URL_NOT_ALLOWED_MESSAGE =
  'This address is on a private network. Solid Ten Sign only calls a private address when the server operator lists its host in NEXT_PRIVATE_WEBHOOK_SSRF_BYPASS_HOSTS.';

/**
 * For the zod schema, which the browser form also runs. The browser never sees the bypass list
 * (it can name internal hosts), so when one is configured the browser lets the URL through.
 *
 * On the server the schema passes and createWebhook / editWebhook call assertWebhookUrlAllowed
 * instead: a zod failure reaches the browser only as raw JSON, an AppError keeps its message.
 */
export const isWebhookUrlAllowedHere = (url: string) => {
  if (typeof window !== 'undefined') {
    return env('NEXT_PUBLIC_WEBHOOK_SSRF_BYPASS_ACTIVE') === 'true' || !isPrivateUrl(url);
  }

  return true;
};

export const assertWebhookUrlAllowed = (url: string) => {
  if (!isWebhookUrlAllowed(url, getServerWebhookSsrfBypassHosts())) {
    throw new AppError(AppErrorCode.WEBHOOK_INVALID_REQUEST, { message: WEBHOOK_URL_NOT_ALLOWED_MESSAGE });
  }
};
