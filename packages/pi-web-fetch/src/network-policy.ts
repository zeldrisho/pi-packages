import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

// Reviewed 2026-08-03 against the IANA IPv4 and IPv6 Special-Purpose Address Registries:
// https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry.xhtml
// https://www.iana.org/assignments/iana-ipv6-special-registry/iana-ipv6-special-registry.xhtml
// Keep non-global, documentation, benchmarking, multicast, and reserved space blocked. The explicit
// endpoints make registry reviews and boundary tests auditable without changing the pinning flow.
export const BLOCKED_IPV4_RANGES = [
  ["0.0.0.0", 8, "0.0.0.0", "0.255.255.255", "current network"],
  ["10.0.0.0", 8, "10.0.0.0", "10.255.255.255", "private use"],
  ["100.64.0.0", 10, "100.64.0.0", "100.127.255.255", "shared address space"],
  ["127.0.0.0", 8, "127.0.0.0", "127.255.255.255", "loopback"],
  ["169.254.0.0", 16, "169.254.0.0", "169.254.255.255", "link local"],
  ["172.16.0.0", 12, "172.16.0.0", "172.31.255.255", "private use"],
  ["192.0.0.0", 24, "192.0.0.0", "192.0.0.255", "protocol assignments"],
  ["192.0.2.0", 24, "192.0.2.0", "192.0.2.255", "documentation"],
  ["192.31.196.0", 24, "192.31.196.0", "192.31.196.255", "AS112 service"],
  ["192.52.193.0", 24, "192.52.193.0", "192.52.193.255", "AS112 service"],
  ["192.88.99.0", 24, "192.88.99.0", "192.88.99.255", "deprecated 6to4 relay"],
  ["192.168.0.0", 16, "192.168.0.0", "192.168.255.255", "private use"],
  ["192.175.48.0", 24, "192.175.48.0", "192.175.48.255", "AS112 service"],
  ["198.18.0.0", 15, "198.18.0.0", "198.19.255.255", "benchmarking"],
  ["198.51.100.0", 24, "198.51.100.0", "198.51.100.255", "documentation"],
  ["203.0.113.0", 24, "203.0.113.0", "203.0.113.255", "documentation"],
  ["224.0.0.0", 4, "224.0.0.0", "239.255.255.255", "multicast"],
  ["240.0.0.0", 4, "240.0.0.0", "255.255.255.255", "reserved"],
] as const;

export const BLOCKED_IPV6_RANGES = [
  ["::", 128, "::", "::", "unspecified"],
  ["::1", 128, "::1", "::1", "loopback"],
  ["::ffff:0:0", 96, "::ffff:0:0", "::ffff:ffff:ffff", "IPv4-mapped"],
  ["64:ff9b::", 96, "64:ff9b::", "64:ff9b::ffff:ffff", "NAT64 translation"],
  ["64:ff9b:1::", 48, "64:ff9b:1::", "64:ff9b:1:ffff:ffff:ffff:ffff:ffff", "local-use translation"],
  ["100::", 64, "100::", "100::ffff:ffff:ffff:ffff", "discard only"],
  ["100:0:0:1::", 64, "100:0:0:1::", "100:0:0:1:ffff:ffff:ffff:ffff", "dummy IPv6 prefix"],
  ["2001::", 23, "2001::", "2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff", "special-purpose allocation"],
  ["2001:db8::", 32, "2001:db8::", "2001:db8:ffff:ffff:ffff:ffff:ffff:ffff", "documentation"],
  ["3fff::", 20, "3fff::", "3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff", "documentation"],
  ["5f00::", 16, "5f00::", "5f00:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "segment routing"],
  ["fc00::", 7, "fc00::", "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "unique local"],
  ["fe80::", 10, "fe80::", "febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "link local"],
  ["ff00::", 8, "ff00::", "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "multicast"],
] as const;

const GLOBALLY_REACHABLE_IPV6_EXCEPTIONS = ["2001:1::1", "2001:1::2", "2001:1::3"];

const blockedIPv4Addresses = new BlockList();
const blockedIPv6Addresses = new BlockList();
const allowedIPv6Addresses = new BlockList();

for (const [network, prefix] of BLOCKED_IPV4_RANGES) {
  blockedIPv4Addresses.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of BLOCKED_IPV6_RANGES) {
  blockedIPv6Addresses.addSubnet(network, prefix, "ipv6");
}
for (const address of GLOBALLY_REACHABLE_IPV6_EXCEPTIONS) {
  allowedIPv6Addresses.addAddress(address, "ipv6");
}

export interface ValidatedTarget {
  url: URL;
  address: string;
  family: 4 | 6;
}

export type ResolveAddresses = (hostname: string) => Promise<string[]>;

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blockedIPv4Addresses.check(address, "ipv4");
  if (family === 6) {
    if (allowedIPv6Addresses.check(address, "ipv6")) return false;
    return blockedIPv6Addresses.check(address, "ipv6");
  }
  return true;
}

export async function validateRemoteUrl(
  value: string | URL,
  resolveHostname?: ResolveAddresses,
): Promise<ValidatedTarget> {
  const url = value instanceof URL ? value : new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("web_fetch only supports HTTP and HTTPS URLs.");
  if (url.username || url.password)
    throw new Error("web_fetch blocks URLs containing credentials.");

  const hostname = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error("web_fetch blocks local hostnames.");
  }

  let addresses: string[];
  if (isIP(hostname)) addresses = [hostname];
  else if (resolveHostname) addresses = await resolveHostname(hostname);
  else {
    const records = await dnsLookup(hostname, { all: true, verbatim: true });
    addresses = [];
    for (const record of records) addresses.push(record.address);
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new Error(`web_fetch blocks private or reserved network targets (${hostname}).`);
  }
  const address = addresses[0];
  const family = isIP(address);
  if (family !== 4 && family !== 6) throw new Error(`web_fetch could not resolve ${hostname}.`);
  return { url, address, family };
}
