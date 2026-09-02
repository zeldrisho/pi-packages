import { describe, expect, it } from "vite-plus/test";
import fileRemove from "../src/index";

describe("deprecated extension", () => {
  it("is a no-op", () => {
    expect(fileRemove()).toBeUndefined();
  });
});
