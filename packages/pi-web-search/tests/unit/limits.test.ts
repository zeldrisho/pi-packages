import { readFile } from "node:fs/promises";
import { Check } from "typebox/value";
import { describe, expect, it } from "vite-plus/test";
import { webSearchParameters } from "../../src/index";
import { SEARCH_WEB_MAX_QUERY_CHARACTERS } from "../../src/limits";

describe("web_search limit contracts", () => {
  it("exposes only the compact model-facing parameters", () => {
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
    const schema = JSON.parse(JSON.stringify(webSearchParameters));
    expect(Object.keys(schema.properties)).toEqual(["query"]);
    expect(schema.properties.query.description).toBeUndefined();
    expect(schema.properties.freshness).toBeUndefined();
    expect(schema.properties.spellcheck).toBeUndefined();
  });

  it("keeps documented query limits aligned with the constants", async () => {
    const readme = await readFile(new URL("../../README.md", import.meta.url), "utf8");
    expect(readme).toContain(
      `Queries are limited to ${SEARCH_WEB_MAX_QUERY_CHARACTERS} characters`,
    );
  });
});
