import { describe, expect, it } from "vite-plus/test";
import {
  FETCH_MAX_BYTES,
  isPrivateAddress,
  requestPinned,
  validateRemoteUrl,
} from "../src/network";

describe("network compatibility facade", () => {
  it("delegates behavior to the underlying modules", async () => {
    expect(FETCH_MAX_BYTES).toBeGreaterThan(0);

    expect(isPrivateAddress("127.0.0.1")).toBe(true);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);

    await expect(
      validateRemoteUrl("https://example.com", async () => ["93.184.216.34"]),
    ).resolves.toBeTruthy();
    await expect(
      validateRemoteUrl("http://localhost/x", async () => ["127.0.0.1"]),
    ).rejects.toThrow();

    // requestPinned is exercised through transport tests; here we only pin the
    // facade re-export to a stable call signature.
    expect(requestPinned.length).toBeGreaterThanOrEqual(1);
  });
});
