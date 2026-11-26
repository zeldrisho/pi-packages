import { Check } from "typebox/value";
import { describe, expect, it } from "vite-plus/test";
import { executeWebFetch, webFetchParameters } from "../src/index";
import {
  FETCH_MAX_CHARACTERS,
  FETCH_MAX_OFFSET_CHARACTERS,
  FETCH_MAX_QUERY_CHARACTERS,
  FETCH_MAX_URL_CHARACTERS,
} from "../src/limits";

describe("web_fetch limit contracts", () => {
  it("exposes only URL, focus query, and character offset with runtime bounds", () => {
    const schema = JSON.parse(JSON.stringify(webFetchParameters));
    expect(Object.keys(schema.properties)).toEqual(["url", "query", "offset"]);
    expect(schema.properties.url.description).toBeUndefined();
    expect(schema.properties.query.description).toContain("page sections");
    expect(schema.properties.offset.description).toContain("character offset in the selected view");
    expect(JSON.stringify(schema)).not.toContain("maxCharacters");
    expect(
      Check(webFetchParameters, {
        url: "x".repeat(FETCH_MAX_URL_CHARACTERS),
        query: "x".repeat(FETCH_MAX_QUERY_CHARACTERS),
        offset: FETCH_MAX_OFFSET_CHARACTERS,
      }),
    ).toBe(true);

    for (const params of [
      { url: "" },
      { url: "x".repeat(FETCH_MAX_URL_CHARACTERS + 1) },
      { url: "https://example.com", query: "" },
      { url: "https://example.com", query: "x".repeat(FETCH_MAX_QUERY_CHARACTERS + 1) },
      { url: "https://example.com", offset: -1 },
      { url: "https://example.com", offset: 0.5 },
      { url: "https://example.com", offset: FETCH_MAX_OFFSET_CHARACTERS + 1 },
    ])
      expect(Check(webFetchParameters, params)).toBe(false);
  });

  it("rejects invalid URL lengths and numeric limits at runtime", async () => {
    const url = "https://example.com";

    const samples = [
      ["fractional offset", { url, offset: 1.5 }, "offset must be an integer"],
      [
        "oversized URL",
        { url: "x".repeat(FETCH_MAX_URL_CHARACTERS + 1) },
        "url must contain between 1 and 2048 characters",
      ],
      [
        "oversized offset",
        { url, offset: FETCH_MAX_OFFSET_CHARACTERS + 1 },
        "offset must be an integer",
      ],
      ["fractional maxCharacters", { url, maxCharacters: 1.5 }, "maxCharacters must be an integer"],
      [
        "oversized maxCharacters",
        { url, maxCharacters: FETCH_MAX_CHARACTERS + 1 },
        "maxCharacters must be an integer",
      ],
    ] as const;

    for (const [label, params, message] of samples) {
      await expect
        .soft(executeWebFetch(params, undefined, undefined), label)
        .rejects.toThrow(message);
    }
  });
});
