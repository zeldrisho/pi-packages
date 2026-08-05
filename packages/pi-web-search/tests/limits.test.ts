import { readFile } from "node:fs/promises";
import { Check } from "typebox/value";
import { describe, expect, it } from "vite-plus/test";
import { webSearchParameters } from "../src/index";
import {
  SEARCH_CONTEXT_MAX_QUERY_CHARACTERS,
  SEARCH_DEFAULT_RESULT_COUNT,
  SEARCH_MAX_RESULT_COUNT,
  SEARCH_WEB_MAX_QUERY_CHARACTERS,
} from "../src/limits";

describe("web_search limit contracts", () => {
  it("keeps schema bounds and descriptions aligned with provider constants", () => {
    expect(
      Check(webSearchParameters, {
        query: "x".repeat(SEARCH_WEB_MAX_QUERY_CHARACTERS),
        mode: "context",
      }),
    ).toBe(true);
    expect(
      Check(webSearchParameters, {
        query: "x".repeat(SEARCH_WEB_MAX_QUERY_CHARACTERS + 1),
        mode: "context",
      }),
    ).toBe(false);
    expect(
      Check(webSearchParameters, {
        query: "x".repeat(SEARCH_WEB_MAX_QUERY_CHARACTERS),
        mode: "web",
        count: SEARCH_MAX_RESULT_COUNT,
      }),
    ).toBe(true);
    expect(Check(webSearchParameters, { query: "x", count: SEARCH_MAX_RESULT_COUNT + 1 })).toBe(
      false,
    );
    expect(JSON.stringify(webSearchParameters)).toContain(
      `default: ${SEARCH_DEFAULT_RESULT_COUNT}`,
    );
  });

  it("keeps documented query limits aligned with the constants", async () => {
    const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toContain(
      `Context queries are limited to ${SEARCH_CONTEXT_MAX_QUERY_CHARACTERS} characters`,
    );
    expect(readme).toContain(
      `web-mode queries are limited to ${SEARCH_WEB_MAX_QUERY_CHARACTERS} characters`,
    );
  });
});
