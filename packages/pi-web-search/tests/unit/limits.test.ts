import { readFile } from "node:fs/promises";
import { Check } from "typebox/value";
import { describe, expect, it } from "vite-plus/test";
import { webSearchParameters } from "../../src/index";
import {
  SEARCH_CONTEXT_MAX_QUERY_CHARACTERS,
  SEARCH_WEB_MAX_QUERY_CHARACTERS,
} from "../../src/limits";

describe("web_search limit contracts", () => {
  // Context-mode queries pass schema validation up to the web-mode length
  // because the provider rejects union schemas; the tighter context limit is
  // enforced at runtime in schema-rendering.test.ts ("enforces the tighter
  // context query limit at runtime"). Keep that coupling discoverable.
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
    expect(Object.keys(schema.properties)).toEqual(["query", "freshness", "spellcheck"]);
    expect(schema.properties.query.description).toBeUndefined();
    expect(schema.properties.mode).toBeUndefined();
    expect(schema.properties.freshness.enum).toEqual(["day", "week", "month", "year"]);
    expect(schema.properties.spellcheck.description).toBe(
      "Set false for exact identifiers/error strings.",
    );
  });

  it("keeps documented query limits aligned with the constants", async () => {
    const readme = await readFile(new URL("../../README.md", import.meta.url), "utf8");
    expect(readme).toContain(
      `Queries are limited to ${SEARCH_WEB_MAX_QUERY_CHARACTERS} characters`,
    );
    expect(SEARCH_CONTEXT_MAX_QUERY_CHARACTERS).toBe(SEARCH_WEB_MAX_QUERY_CHARACTERS);
  });
});
