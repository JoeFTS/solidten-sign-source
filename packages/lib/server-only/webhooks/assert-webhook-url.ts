import { lookup } from 'node:dns/promises';
import { z } from 'zod';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { withTimeout } from '../../utils/timeout';
import { isPrivateUrl } from './is-private-url';
import {
  isWebhookSsrfBypassedHost,
  normalizeWebhookHostname as normalizeHostname,
  WEBHOOK_URL_NOT_ALLOWED_MESSAGE,
} from './webhook-url-rule';

const ZIpSchema = z.string().ip();

// Solid Ten Sign (S-L4): a timeout now refuses the call, so allow a normal resolver time.
const WEBHOOK_DNS_LOOKUP_TIMEOUT_MS = 3000;

type TLookupAddress = {
  address: string;
  family: number;
};

type TLookupFn = (
  hostname: string,
  options: {
    all: true;
    verbatim: true;
  },
) => Promise<TLookupAddress[] | TLookupAddress>;

const toAddressUrl = (address: string) => (address.includes(':') ? `http://[${address}]` : `http://${address}`);

export type TWebhookTarget = {
  /** The address the request must connect to, or null to let the system resolve (bypass hosts). */
  pinned: { address: string; family: 4 | 6 } | null;
};

/**
 * Solid Ten Sign (retest): the host did not resolve (or the lookup timed out). Refused at save
 * time, but on delivery it is a network failure like any other and is retried, not final.
 */
export const WEBHOOK_HOST_UNRESOLVED_MESSAGE =
  'The webhook host could not be resolved. Check the address and try again.';

export const isWebhookHostUnresolvedError = (error: unknown) =>
  error instanceof AppError && error.message === WEBHOOK_HOST_UNRESOLVED_MESSAGE;

const refused = (message = WEBHOOK_URL_NOT_ALLOWED_MESSAGE) =>
  new AppError(AppErrorCode.WEBHOOK_INVALID_REQUEST, { message });

/**
 * Assert that a webhook URL does not point at a private/loopback address,
 * checking both the literal host and its resolved DNS records. Throws an
 * AppError with WEBHOOK_INVALID_REQUEST if it does. Hosts listed in
 * NEXT_PRIVATE_WEBHOOK_SSRF_BYPASS_HOSTS skip all checks.
 *
 * Solid Ten Sign (S-L4): fails closed. A lookup that errors or times out is
 * refused, and the address that was checked is returned so the caller can pin
 * the request to it (no second lookup, so no DNS rebinding between check and
 * call). Network-level egress rules remain the deployment's job.
 */
export const assertNotPrivateUrl = async (
  url: string,
  options?: {
    lookup?: TLookupFn;
  },
): Promise<TWebhookTarget> => {
  if (isWebhookSsrfBypassedHost(url)) {
    return { pinned: null };
  }

  if (isPrivateUrl(url)) {
    throw refused();
  }

  let hostname: string;

  try {
    hostname = normalizeHostname(new URL(url).hostname);
  } catch {
    throw refused('The webhook URL is not valid.');
  }

  if (hostname.length === 0) {
    throw refused('The webhook URL is not valid.');
  }

  if (ZIpSchema.safeParse(hostname).success) {
    return { pinned: { address: hostname, family: hostname.includes(':') ? 6 : 4 } };
  }

  const resolveHostname = options?.lookup ?? lookup;

  const lookupResult = await withTimeout(
    resolveHostname(hostname, {
      all: true,
      verbatim: true,
    }),
    WEBHOOK_DNS_LOOKUP_TIMEOUT_MS,
  ).catch(() => null);

  const addresses = lookupResult ? (Array.isArray(lookupResult) ? lookupResult : [lookupResult]) : [];

  if (addresses.length === 0) {
    throw refused(WEBHOOK_HOST_UNRESOLVED_MESSAGE);
  }

  if (addresses.some(({ address }) => isPrivateUrl(toAddressUrl(address)))) {
    throw refused();
  }

  const [first] = addresses;

  return { pinned: { address: first.address, family: first.family === 6 ? 6 : 4 } };
};
