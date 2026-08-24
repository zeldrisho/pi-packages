import { describe, expect, it, vi } from "vite-plus/test";
import { createSearchTool, jsonResponse, type SearchParameters } from "./harness";

/**
 * Runs one web search and returns the URL of the provider request it made.
 *
 * @param params - The search parameters to execute
 * @returns The request URL captured from the stubbed global fetch
 */
async function runSearchCapturingUrl(params: SearchParameters): Promise<URL> {
  let url: URL | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      url = new URL(input instanceof Request ? input.url : String(input));
      return jsonResponse({ web: { results: [] } });
    }),
  );
  await createSearchTool().execute("call", params, undefined, undefined);
  if (!url) throw new Error("the provider request was not made");
  return url;
}

describe("web_search web-mode parameters", () => {
  it("passes country, safesearch, and extra_snippets to Brave", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "param-secret";

    const url = await runSearchCapturingUrl({
      query: "params query",
      country: "DE",
      safesearch: "off",
      extraSnippets: true,
    });

    expect(url.searchParams.get("country")).toBe("DE");
    expect(url.searchParams.get("safesearch")).toBe("off");
    expect(url.searchParams.get("extra_snippets")).toBe("true");
  });

  it("defaults safesearch to moderate and omits unset options", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "default-secret";

    const url = await runSearchCapturingUrl({ query: "defaults query" });

    expect(url.searchParams.get("safesearch")).toBe("moderate");
    expect(url.searchParams.has("country")).toBe(false);
    expect(url.searchParams.has("extra_snippets")).toBe(false);
  });

  it("includes web-only options in the cache key", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "cache-secret";
    let requests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        requests += 1;
        return jsonResponse({
          web: { results: [{ title: "A", url: "https://example.com/a", description: "d" }] },
        });
      }),
    );
    const tool = createSearchTool();

    await tool.execute("call", { query: "cache query", country: "US" }, undefined, undefined);
    await tool.execute("call", { query: "cache query", country: "DE" }, undefined, undefined);
    expect(requests).toBe(2);

    await tool.execute("call", { query: "cache query", country: "US" }, undefined, undefined);
    expect(requests).toBe(2);
  });
});

describe("web_search extra snippets rendering", () => {
  it("appends extra snippets to the result snippet text", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "snippets-secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
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
        }),
      ),
    );

    const result = await createSearchTool().execute(
      "call",
      { query: "extras query", extraSnippets: true },
      undefined,
      undefined,
    );
    const snippet = result.details.results[0]?.snippet;
    expect(snippet).toContain("main summary");
    expect(snippet).toContain("first excerpt");
    expect(snippet).toContain("second excerpt");
  });

  it("rejects web-only options in context mode before contacting the provider", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "context-secret";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createSearchTool().execute(
        "call",
        { query: "context query", mode: "context", country: "US" },
        undefined,
        undefined,
      ),
    ).rejects.toThrow("only supported in web mode");
    await expect(
      createSearchTool().execute(
        "call",
        { query: "context query", mode: "context", extraSnippets: true },
        undefined,
        undefined,
      ),
    ).rejects.toThrow("only supported in web mode");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
