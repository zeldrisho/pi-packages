import { describe, expect, it, vi } from "vite-plus/test";
import { createSearchTool, jsonResponse } from "./harness";

describe("web_search web-mode parameters", () => {
  it("registers for direct and codemode calls", () => {
    const tool = createSearchTool();
    expect(tool).not.toHaveProperty("exposure");
    expect(tool).toMatchObject({
      name: "web_search",
      outputSchema: expect.any(Object),
    });
  });

  it("sends web defaults and applies explicit options and extra snippets", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "param-secret";
    const urls: URL[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        urls.push(url);

        return jsonResponse({
          web: {
            results: [
              {
                title: "A",
                url: "https://example.com/a",
                description: "main summary",
                extra_snippets: ["first excerpt", "", "second excerpt"],
              },
            ],
          },
        });
      }),
    );

    const tool = createSearchTool();
    const query = "web options";
    await tool.execute("default", { query }, undefined, undefined);

    const result = await tool.execute(
      "custom",
      { query, country: "DE", safesearch: "off", extraSnippets: true },
      undefined,
      undefined,
    );

    expect(urls).toHaveLength(2);
    const [defaults, custom] = urls;
    expect(defaults?.href).toMatch(/^https:\/\/api\.search\.brave\.com\/res\/v1\/web\/search\?/u);
    expect(Object.fromEntries(defaults?.searchParams ?? [])).toMatchObject({
      count: "5",
      operators: "true",
      safesearch: "moderate",
    });
    expect(defaults?.searchParams.has("country")).toBe(false);
    expect(defaults?.searchParams.has("extra_snippets")).toBe(false);
    expect(Object.fromEntries(custom?.searchParams ?? [])).toMatchObject({
      country: "DE",
      safesearch: "off",
      extra_snippets: "true",
    });

    const snippet = result.details.results[0]?.snippet;
    expect(snippet).toContain("main summary");
    expect(snippet).toContain("first excerpt");
    expect(snippet).toContain("second excerpt");
  });

  it("keys cached results by country even when other options are identical", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "cache-secret";

    const fetchMock = vi.fn(async () =>
      jsonResponse({
        web: { results: [{ title: "A", url: "https://example.com/a", description: "d" }] },
      }),
    );

    vi.stubGlobal("fetch", fetchMock);
    const tool = createSearchTool();
    const query = "cache query";

    await tool.execute("first", { query, country: "US" }, undefined, undefined);
    await tool.execute("second", { query, country: "DE" }, undefined, undefined);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const repeated = await tool.execute("cached", { query, country: "US" }, undefined, undefined);
    expect(repeated.details.cached).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
