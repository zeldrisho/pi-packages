import { Check } from "typebox/value";
import { describe, expect, it } from "vite-plus/test";
import { executeWebFetch, webFetchParameters } from "../../src/index";
import {
  FETCH_MAX_CHARACTERS,
  FETCH_MAX_OFFSET_CHARACTERS,
  FETCH_MAX_URL_CHARACTERS,
} from "../../src/limits";

describe("web_fetch limit contracts", () => {
  it("exposes only URL, focus query, and character offset without bounds", () => {
    const schema = JSON.parse(JSON.stringify(webFetchParameters));
    expect(Object.keys(schema.properties)).toEqual(["url", "query", "offset"]);
    expect(schema.properties.url.description).toBeUndefined();
    expect(schema.properties.query.description).toBe("Return only matching sections (long pages).");
    expect(schema.properties.offset.description).toBe(
      "Character offset; use nextOffset to continue.",
    );
    expect(JSON.stringify(schema)).not.toContain("maxCharacters");
    expect(
      Check(webFetchParameters, {
        url: "https://example.com",
        offset: FETCH_MAX_OFFSET_CHARACTERS + 1,
      }),
    ).toBe(true);
  });

  it.each([
    [{ url: "https://example.com", offset: 1.5 }, "offset must be an integer"],
    [
      { url: "x".repeat(FETCH_MAX_URL_CHARACTERS + 1) },
      "url must contain between 1 and 2048 characters",
    ],
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
