import { describe, expect, it, vi } from "vite-plus/test";
import { createSearchTool, jsonResponse } from "./harness";

describe("web_search web-mode parameters", () => {
  it("sends defaults and keeps results for distinct web options separate in cache", async () => {
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
    expect(tool).not.toHaveProperty("exposure");
    expect(tool).toMatchObject({ name: "web_search", outputSchema: expect.any(Object) });

    const query = "web options";
    const params = { query, country: "DE", safesearch: "off", extraSnippets: true } as const;
    await tool.execute("default", { query }, undefined, undefined);
    const result = await tool.execute("custom", params, undefined, undefined);
    await tool.execute("other-country", { ...params, country: "US" }, undefined, undefined);
    const repeated = await tool.execute("cached", params, undefined, undefined);

    expect(repeated.details.cached).toBe(true);
    expect(repeated.content).toEqual(result.content);
    expect(urls).toHaveLength(3);
    const [defaults, custom, otherCountry] = urls;
    expect(otherCountry?.searchParams.get("country")).toBe("US");
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
});
