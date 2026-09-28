import { Check } from "typebox/value";
import { describe, expect, it } from "vite-plus/test";
import { executeWebFetch, webFetchParameters } from "../../src/index";
import { FETCH_MAX_CHARACTERS, FETCH_MAX_OFFSET_CHARACTERS } from "../../src/limits";

describe("web_fetch limit contracts", () => {
  it("exposes only URL, focus, and continuation controls", () => {
    expect(Check(webFetchParameters, { url: "https://example.com" })).toBe(true);
    expect(Check(webFetchParameters, { url: "https://example.com", offset: 1 })).toBe(true);
    expect(JSON.stringify(webFetchParameters)).not.toContain("maxCharacters");
    expect(
      Check(webFetchParameters, {
        url: "https://example.com",
        offset: FETCH_MAX_OFFSET_CHARACTERS + 1,
      }),
    ).toBe(false);
  });

  it.each([
    [{ url: "https://example.com", offset: 1.5 }, "offset must be an integer"],
    [
      { url: "https://example.com", offset: FETCH_MAX_OFFSET_CHARACTERS + 1 },
      "offset must be an integer",
    ],
    [{ url: "https://example.com", maxCharacters: 1.5 }, "maxCharacters must be an integer"],
    [
      { url: "https://example.com", maxCharacters: FETCH_MAX_CHARACTERS + 1 },
      "maxCharacters must be an integer",
    ],
  ])("enforces runtime limits for %j", async (params, message) => {
    await expect(executeWebFetch(params, undefined, undefined)).rejects.toThrow(message);
  });
});
