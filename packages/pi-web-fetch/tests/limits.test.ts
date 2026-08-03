import { Check } from "typebox/value";
import { describe, expect, it } from "vite-plus/test";
import { webFetchParameters } from "../src/index";
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
});
