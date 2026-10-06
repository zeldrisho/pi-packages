import { describe, expect, it } from "vite-plus/test";
import { isPrivateAddress } from "../../src/network-policy";
import { redactUrlForDisplay } from "../../src/redact";

/** Small deterministic PRNG so failures are reproducible without an extra dependency. */
function* values(seed: number): Generator<number> {
  let state = seed >>> 0;

  while (true) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    yield state;
  }
}

describe("deterministic property regressions", () => {
  it("does not classify generated public IPv4 addresses as private", () => {
    const random = values(0x5eed);

    for (let i = 0; i < 256; i += 1) {
      // 8/8 and 11/8 are globally routable and outside the blocked special ranges.
      const firstOctet = i % 2 === 0 ? 8 : 11;
      const address = `${firstOctet}.${random.next().value! & 255}.${random.next().value! & 255}.${random.next().value! & 255}`;
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });

  it("never exposes generated sensitive query or fragment values", () => {
    const random = values(0xc0ffee);

    for (let i = 0; i < 128; i += 1) {
      const secret = `secret-${random.next().value!.toString(16)}-${i}`;

      const displayed = redactUrlForDisplay(
        `https://user:${encodeURIComponent(secret)}@example.com/?token=${encodeURIComponent(secret)}#access_token=${encodeURIComponent(secret)}`,
      );

      expect(displayed).not.toContain(secret);
      expect(displayed).toContain("REDACTED");
      expect(displayed).not.toContain("user:");
    }
  });
});
