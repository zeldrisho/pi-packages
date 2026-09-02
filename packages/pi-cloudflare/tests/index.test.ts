import { describe, expect, it } from "vite-plus/test";
import cloudflare from "../src/index";

describe("deprecated extension", () => {
  it("is a no-op", () => {
    expect(cloudflare()).toBeUndefined();
  });
});
