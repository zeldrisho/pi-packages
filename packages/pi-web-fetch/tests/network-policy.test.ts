import { describe, expect, it } from "vite-plus/test";
import {
  BLOCKED_IPV4_RANGES,
  BLOCKED_IPV6_RANGES,
  isPrivateAddress,
  validateRemoteUrl,
} from "../src/network-policy";

describe("web_fetch address policy", () => {
  it.each([
    ...BLOCKED_IPV4_RANGES.flatMap(
      ([network, prefix, first, last]) =>
        [
          [`${network}/${prefix} first`, first],
          [`${network}/${prefix} last`, last],
        ] as const,
    ),
    ...BLOCKED_IPV6_RANGES.flatMap(
      ([network, prefix, first, last]) =>
        [
          [`${network}/${prefix} first`, first],
          [`${network}/${prefix} last`, last],
        ] as const,
    ),
  ])("blocks the %s address %s", (_boundary, address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each([
    "1.0.0.0",
    "9.255.255.255",
    "11.0.0.0",
    "100.63.255.255",
    "100.128.0.0",
    "169.253.255.255",
    "169.255.0.0",
    "172.15.255.255",
    "172.32.0.0",
    "192.0.1.255",
    "192.0.3.0",
    "198.17.255.255",
    "198.20.0.0",
    "203.0.112.255",
    "203.0.114.0",
    "2000:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    "2001:200::",
    "2001:db7:ffff:ffff:ffff:ffff:ffff:ffff",
    "2001:db9::",
    "fe7f:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    "fec0::",
  ])("does not block the adjacent policy address %s", (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });

  it.each(["2001:1::1", "2001:1::2", "2001:1::3"])(
    "permits the globally reachable special-purpose exception %s",
    (address) => {
      expect(isPrivateAddress(address)).toBe(false);
    },
  );

  it.each([
    ["2001:3::/32 first", "2001:3::"],
    ["2001:3::/32 last", "2001:3:ffff:ffff:ffff:ffff:ffff:ffff"],
    ["2001:4:112::/48 first", "2001:4:112::"],
    ["2001:4:112::/48 last", "2001:4:112:ffff:ffff:ffff:ffff:ffff"],
    ["2001:20::/28 first", "2001:20::"],
    ["2001:20::/28 last", "2001:2f:ffff:ffff:ffff:ffff:ffff:ffff"],
    ["2001:30::/28 first", "2001:30::"],
    ["2001:30::/28 last", "2001:3f:ffff:ffff:ffff:ffff:ffff:ffff"],
  ])("accepts the globally reachable %s boundary", async (_boundary, address) => {
    await expect(validateRemoteUrl(`https://[${address}]`)).resolves.toMatchObject({ address });
  });

  it.each([
    "2001:1:ffff:ffff:ffff:ffff:ffff:ffff",
    "2001:2:ffff:ffff:ffff:ffff:ffff:ffff",
    "2001:4::",
    "2001:4:111:ffff:ffff:ffff:ffff:ffff",
    "2001:4:113::",
    "2001:40::",
  ])("rejects non-global addresses outside the exceptions (%s)", async (address) => {
    await expect(validateRemoteUrl(`https://[${address}]`)).rejects.toThrow("private or reserved");
  });

  it.each(["https://example.com", "http://example.com"])(
    "accepts public target %s",
    async (url) => {
      const target = await validateRemoteUrl(url, async () => ["93.184.216.34"]);
      expect(target.address).toBe("93.184.216.34");
    },
  );

  it.each([
    ["file:///etc/passwd", "only supports HTTP"],
    ["https://user:password@example.com", "containing credentials"],
    ["http://localhost", "local hostnames"],
    ["http://service.localhost", "local hostnames"],
  ])("rejects unsafe URL %s", async (url, message) => {
    await expect(validateRemoteUrl(url)).rejects.toThrow(message);
  });

  it("rejects a hostname when any DNS answer is private", async () => {
    await expect(
      validateRemoteUrl("https://example.test", async () => ["93.184.216.34", "127.0.0.1"]),
    ).rejects.toThrow("private or reserved");
  });
});
