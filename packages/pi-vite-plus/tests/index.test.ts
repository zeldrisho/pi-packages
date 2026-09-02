import { describe, expect, it } from "vite-plus/test";
import vitePlus from "../src/index";

describe("deprecated extension", () => {
  it("is a no-op", () => {
    expect(vitePlus()).toBeUndefined();
  });
});
