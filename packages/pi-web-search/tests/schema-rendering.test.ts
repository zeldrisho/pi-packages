import { Check } from "typebox/value";
import { describe, expect, it, vi } from "vite-plus/test";
import { webSearchParameters } from "../src/index";
import {
  SEARCH_CONTEXT_MAX_QUERY_CHARACTERS,
  SEARCH_WEB_MAX_QUERY_CHARACTERS,
} from "../src/limits";
import { createSearchTool, jsonResponse, renderTheme } from "./harness";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...actual, keyHint: () => "Ctrl+O to expand" };
});

describe("web_search schema rendering", () => {
  it("exposes a provider-compatible object schema without allOf or anyOf", () => {
    expect(webSearchParameters.type).toBe("object");
    const schema = JSON.stringify(webSearchParameters);
    expect(schema).not.toContain("allOf");
    expect(schema).not.toContain("anyOf");
    expect(Check(webSearchParameters, { query: "x" })).toBe(true);
    expect(Check(webSearchParameters, { query: "x", mode: "web" })).toBe(true);
    expect(Check(webSearchParameters, { query: "x", mode: "context" })).toBe(true);
    expect(Check(webSearchParameters, { query: "x", mode: "other" })).toBe(false);
  });

  it("accepts up to the web query limit for either mode at the schema level", () => {
    expect(
      Check(webSearchParameters, {
        query: "x".repeat(SEARCH_WEB_MAX_QUERY_CHARACTERS),
        mode: "context",
      }),
    ).toBe(true);
    expect(
      Check(webSearchParameters, {
        query: "x".repeat(SEARCH_WEB_MAX_QUERY_CHARACTERS),
        mode: "web",
      }),
    ).toBe(true);
    expect(
      Check(webSearchParameters, { query: "x".repeat(SEARCH_WEB_MAX_QUERY_CHARACTERS + 1) }),
    ).toBe(false);
  });

  it("enforces the tighter context query limit at runtime", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "test-secret";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      createSearchTool().execute(
        "call",
        { query: "x".repeat(SEARCH_CONTEXT_MAX_QUERY_CHARACTERS + 1), mode: "context" },
        undefined,
        undefined,
      ),
    ).rejects.toThrow(
      `Search queries cannot exceed ${SEARCH_CONTEXT_MAX_QUERY_CHARACTERS} characters.`,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails clearly when the API key is missing", async () => {
    delete process.env.BRAVE_SEARCH_API_KEY;
    const tool = createSearchTool();
    await expect(tool.execute("call", { query: "pi" }, undefined, undefined)).rejects.toThrow(
      "BRAVE_SEARCH_API_KEY is required",
    );
  });

  it("rejects whitespace-only queries before making a request", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "test-secret";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      createSearchTool().execute("call", { query: "   " }, undefined, undefined),
    ).rejects.toThrow("cannot be empty");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("constructs bounded Brave web requests and normalizes results", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "test-secret";
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      expect(url.origin + url.pathname).toBe("https://api.search.brave.com/res/v1/web/search");
      expect(url.searchParams.get("q")).toBe("pi extensions");
      expect(url.searchParams.get("count")).toBe("2");
      expect(url.searchParams.get("freshness")).toBe("pw");
      expect(url.searchParams.get("search_lang")).toBe("en-US");
      expect(new Headers(init?.headers).get("X-Subscription-Token")).toBe("test-secret");
      return jsonResponse({
        web: {
          results: [
            {
              title: "<b>Result</b>",
              url: "https://example.com/path",
              description: "A   useful <em>snippet</em>",
            },
            { title: "Unsafe", url: "javascript:alert(1)", description: "ignored" },
          ],
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await createSearchTool().execute(
      "call",
      { query: " pi extensions ", count: 2, freshness: "week", language: "en-US" },
      undefined,
      undefined,
    );

    expect(result.details.resultCount).toBe(1);
    expect(result.details.results[0]).toEqual({
      title: "Result",
      url: "https://example.com/path",
      snippet: "A useful snippet",
    });
    expect(result.content[0].text).toContain("untrusted external data");
    expect(result.details.truncation).toMatchObject({
      truncated: false,
      strategy: "none",
    });
  });

  it("shows a Pi-style result preview until tool output is expanded", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "render-secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          web: {
            results: [
              { title: "First title", url: "https://example.com/first", description: "First" },
              { title: "Second title", url: "https://example.com/second", description: "Second" },
              { title: "Third title", url: "https://example.com/third", description: "Third" },
            ],
          },
        }),
      ),
    );
    const tool = createSearchTool();
    const result = await tool.execute(
      "call",
      { query: "unique renderer query 721", count: 3 },
      undefined,
      undefined,
    );

    const collapsed = tool
      .renderResult(result, { expanded: false, isPartial: false }, renderTheme)
      .render(200)
      .join("\n");
    const expanded = tool
      .renderResult(result, { expanded: true, isPartial: false }, renderTheme)
      .render(200)
      .join("\n");

    expect(collapsed).toContain("First title");
    expect(collapsed).toContain("more lines");
    expect(collapsed).not.toContain("Second title");
    expect(expanded).toContain("Third title");
    expect(expanded).not.toContain("more lines");
    expect(
      tool.renderCall({ query: "pi extensions" }, renderTheme).render(200).join("\n"),
    ).toContain("web_search pi extensions");
    expect(
      tool
        .renderResult(result, { expanded: false, isPartial: true }, renderTheme)
        .render(200)
        .join("\n"),
    ).toContain("Searching…");
    expect(
      tool
        .renderResult(
          { ...result, content: [] },
          { expanded: false, isPartial: false },
          renderTheme,
        )
        .render(200)
        .join("\n"),
    ).toContain("No results");
  });
});
