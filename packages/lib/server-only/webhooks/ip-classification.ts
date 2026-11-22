import { z } from 'zod';

// No node:net here: the webhook form runs this check in the browser too.
const ZIPv4Schema = z.string().ip({ version: 'v4' });
const ZIPv6Schema = z.string().ip({ version: 'v6' });

const isIPv4 = (value: string) => ZIPv4Schema.safeParse(value).success;
const isIPv6 = (value: string) => ZIPv6Schema.safeParse(value).success;

/**
 * Solid Ten Sign (S-L4): "public unicast only" for webhook targets. An address passes
 * only when it is a globally reachable unicast address: everything in the IANA
 * special-purpose registries (loopback, private, shared, link-local, documentation,
 * benchmarking, multicast, reserved, and the IPv6 forms that embed or translate IPv4)
 * is refused. Replaces a hand-written list of prefixes.
 */

type TCidr = [bytes: number[], prefixLength: number];

const parseIPv4 = (address: string): number[] | null => {
  if (!isIPv4(address)) {
    return null;
  }

  return address.split('.').map((part) => Number.parseInt(part, 10));
};

const parseIPv6 = (input: string): number[] | null => {
  let address = input.replace(/%.*$/, '');

  if (!isIPv6(address)) {
    return null;
  }

  // A dotted IPv4 tail, as in ::ffff:127.0.0.1, becomes two hex groups.
  const lastColon = address.lastIndexOf(':');
  const tail = address.slice(lastColon + 1);

  if (tail.includes('.')) {
    const v4 = parseIPv4(tail);

    if (!v4) {
      return null;
    }

    const high = ((v4[0] << 8) | v4[1]).toString(16);
    const low = ((v4[2] << 8) | v4[3]).toString(16);

    address = `${address.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const [left, right] = address.includes('::') ? address.split('::') : [address, undefined];
  const leftGroups = left ? left.split(':') : [];
  const rightGroups = right ? right.split(':') : [];

  const missing = 8 - leftGroups.length - rightGroups.length;

  if ((right === undefined && missing !== 0) || missing < 0) {
    return null;
  }

  const groups = [...leftGroups, ...Array.from({ length: missing }, () => '0'), ...rightGroups];

  return groups.flatMap((group) => {
    const value = Number.parseInt(group, 16);

    return [value >> 8, value & 0xff];
  });
};

const toBytes = (address: string) => (address.includes(':') ? parseIPv6(address) : parseIPv4(address));

const cidr = (address: string, prefixLength: number): TCidr => {
  const bytes = toBytes(address);

  if (!bytes) {
    throw new Error(`Bad CIDR ${address}`);
  }

  return [bytes, prefixLength];
};

const isInCidr = (bytes: number[], [network, prefixLength]: TCidr) => {
  if (bytes.length !== network.length) {
    return false;
  }

  for (let bit = 0; bit < prefixLength; bit += 1) {
    const byte = bit >> 3;
    const mask = 0x80 >> (bit & 7);

    if ((bytes[byte] & mask) !== (network[byte] & mask)) {
      return false;
    }
  }

  return true;
};

// IANA IPv4 Special-Purpose Address Registry, plus multicast and the reserved block.
const IPV4_NOT_PUBLIC: TCidr[] = [
  cidr('0.0.0.0', 8), // "this network"
  cidr('10.0.0.0', 8), // private
  cidr('100.64.0.0', 10), // shared address space (carrier-grade NAT)
  cidr('127.0.0.0', 8), // loopback
  cidr('169.254.0.0', 16), // link-local
  cidr('172.16.0.0', 12), // private
  cidr('192.0.0.0', 24), // IETF protocol assignments
  cidr('192.0.2.0', 24), // documentation (TEST-NET-1)
  cidr('192.31.196.0', 24), // AS112-v4
  cidr('192.52.193.0', 24), // AMT
  cidr('192.88.99.0', 24), // deprecated 6to4 relay anycast
  cidr('192.168.0.0', 16), // private
  cidr('192.175.48.0', 24), // direct delegation AS112
  cidr('198.18.0.0', 15), // benchmarking
  cidr('198.51.100.0', 24), // documentation (TEST-NET-2)
  cidr('203.0.113.0', 24), // documentation (TEST-NET-3)
  cidr('224.0.0.0', 4), // multicast
  cidr('240.0.0.0', 4), // reserved, including 255.255.255.255
];

// Inside 2000::/3 (global unicast), the special-purpose blocks that are not public.
const IPV6_GLOBAL_NOT_PUBLIC: TCidr[] = [
  cidr('2001::', 23), // IETF protocol assignments (Teredo, benchmarking, ORCHID, ...)
  cidr('2001:db8::', 32), // documentation
  cidr('2002::', 16), // 6to4: embeds an IPv4 address
  cidr('3fff::', 20), // documentation
];

const IPV6_GLOBAL_UNICAST = cidr('2000::', 3);

// IPv6 forms that carry an IPv4 address: judge the IPv4 address.
const IPV6_V4_MAPPED = cidr('::ffff:0:0', 96);
const IPV6_NAT64 = cidr('64:ff9b::', 96);

const isPublicIPv4Bytes = (bytes: number[]) => !IPV4_NOT_PUBLIC.some((range) => isInCidr(bytes, range));

/**
 * Whether an IP address literal is globally reachable unicast. Anything that does not
 * parse as an IP address returns false.
 */
export const isPublicUnicastIp = (address: string): boolean => {
  const v4 = parseIPv4(address);

  if (v4) {
    return isPublicIPv4Bytes(v4);
  }

  const v6 = parseIPv6(address);

  if (!v6) {
    return false;
  }

  if (isInCidr(v6, IPV6_V4_MAPPED) || isInCidr(v6, IPV6_NAT64)) {
    return isPublicIPv4Bytes(v6.slice(12));
  }

  // Everything else outside 2000::/3 is not public: ::/128, ::1, IPv4-compatible ::/96,
  // 64:ff9b:1::/48, 100::/64, fc00::/7, fe80::/10 (all of it), ff00::/8, ...
  if (!isInCidr(v6, IPV6_GLOBAL_UNICAST)) {
    return false;
  }

  return !IPV6_GLOBAL_NOT_PUBLIC.some((range) => isInCidr(v6, range));
};

export const isIpAddressLiteral = (address: string) => isIPv4(address) || isIPv6(address.replace(/%.*$/, ''));
