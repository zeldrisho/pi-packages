import { readFile } from "node:fs/promises";
import { Check } from "typebox/value";
import { describe, expect, it } from "vite-plus/test";
import { webSearchParameters } from "../src/index";
import { SEARCH_WEB_MAX_QUERY_CHARACTERS } from "../src/limits";

describe("web_search limit contracts", () => {
  it("exposes a provider-compatible schema with a single bounded query", () => {
    expect(webSearchParameters.type).toBe("object");
    expect(JSON.stringify(webSearchParameters)).not.toMatch(/"(?:allOf|anyOf)"/);
    expect(
      Check(webSearchParameters, {
        query: "x".repeat(SEARCH_WEB_MAX_QUERY_CHARACTERS),
      }),
    ).toBe(true);
    expect(
      Check(webSearchParameters, {
        query: "x".repeat(SEARCH_WEB_MAX_QUERY_CHARACTERS + 1),
      }),
    ).toBe(false);
    expect(Object.keys(webSearchParameters.properties)).toEqual(["query"]);
    expect(webSearchParameters.properties.query).not.toHaveProperty("description");
  });

  it("keeps documented query limits aligned with the constants", async () => {
    const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toContain(
      `Queries are limited to ${SEARCH_WEB_MAX_QUERY_CHARACTERS} characters`,
    );
  });
});
