import { describe, expect, it } from "vite-plus/test";
import fileSearch from "../src/index";

describe("deprecated extension", () => {
  it("is a no-op", () => {
    expect(fileSearch()).toBeUndefined();
  });
});
