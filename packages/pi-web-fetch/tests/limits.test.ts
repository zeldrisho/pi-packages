import { Check } from "typebox/value";
import { describe, expect, it } from "vite-plus/test";
import { executeWebFetch, webFetchParameters } from "../src/index";
import {
  FETCH_DEFAULT_MAX_CHARACTERS,
  FETCH_MAX_CHARACTERS,
  FETCH_MAX_OFFSET_CHARACTERS,
  FETCH_MIN_MAX_CHARACTERS,
} from "../src/limits";

describe("web_fetch limit contracts", () => {
  it("keeps schema bounds and descriptions aligned with runtime constants", () => {
    expect(
      Check(webFetchParameters, {
        url: "https://example.com",
        maxCharacters: FETCH_MIN_MAX_CHARACTERS,
      }),
    ).toBe(true);
    expect(
      Check(webFetchParameters, {
        url: "https://example.com",
        maxCharacters: FETCH_MAX_CHARACTERS,
      }),
    ).toBe(true);
    expect(
      Check(webFetchParameters, {
        url: "https://example.com",
        maxCharacters: FETCH_MAX_CHARACTERS + 1,
      }),
    ).toBe(false);
    expect(
      Check(webFetchParameters, {
        url: "https://example.com",
        offset: FETCH_MAX_OFFSET_CHARACTERS + 1,
      }),
    ).toBe(false);
    expect(JSON.stringify(webFetchParameters)).toContain(
      `default: ${FETCH_DEFAULT_MAX_CHARACTERS}`,
    );
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
