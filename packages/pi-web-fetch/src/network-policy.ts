import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

const blockedIPv4Addresses = new BlockList();
const blockedIPv6Addresses = new BlockList();

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.31.196.0", 24],
  ["192.52.193.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["192.175.48.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedIPv4Addresses.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001:2::", 48],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blockedIPv6Addresses.addSubnet(network, prefix, "ipv6");
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
  if (family === 6) return blockedIPv6Addresses.check(address, "ipv6");
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
