import { describe, expect, it } from "vite-plus/test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import cloudflare from "../src/index";

describe("deprecated extension", () => {
  it("is a no-op", () => {
    // SAFETY: any attempted ExtensionAPI access throws before it can have an effect.
    const pi = new Proxy(
      {},
      {
        get() {
          throw new Error("deprecated extension accessed ExtensionAPI");
        },
      },
    ) as ExtensionAPI;
    expect(cloudflare(pi)).toBeUndefined();
  });
});
