import { describe, expect, it, vi } from "vite-plus/test";
import { Check } from "typebox/value";
import { mapFreshness, normalizeResultFilter, validateProviderRequest } from "../src/brave";
import { webSearchParameters } from "../src/index";
import { createSearchTool, jsonResponse } from "./harness";

/** Minimal Brave response stub for request-URL capture tests. */
interface StubProviderResponse {
  query?: {
    altered?: string;
    spellcheck_off?: boolean;
    show_strict_warning?: boolean;
    more_results_available?: boolean;
    search_operators?: { applied?: boolean; sites?: string[] };
  };
  web?: { results: Array<{ title: string; url: string; description: string }> };
  grounding?: { generic: Array<{ title: string; url: string; snippets: string[] }> };
}

/**
 * Runs one search and returns the URL of the provider request it made.
 *
 * @param params - The search parameters to execute
 * @param response - The stubbed provider response body
 * @returns The request URL captured from the stubbed global fetch
 */
async function runSearchCapturingUrl(
  params: Parameters<ReturnType<typeof createSearchTool>["execute"]>[1],
  response: StubProviderResponse = { web: { results: [] } },
): Promise<URL> {
  let url: URL | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      url = new URL(input instanceof Request ? input.url : String(input));
      return jsonResponse(response);
    }),
  );
  await createSearchTool().execute("call", params, undefined, undefined);
  if (!url) throw new Error("the provider request was not made");
  return url;
}

describe("web_search code-search options", () => {
  it("passes operators, spellcheck, result_filter, goggles, offset, and ui_lang to Brave", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "code-secret";

    const url = await runSearchCapturingUrl({
      query: "site:github.com filetype:pdf intitle:vite",
      operators: true,
      spellcheck: false,
      resultFilter: "web,discussions,faq",
      goggles: "https://example.com/docs.goggle",
      offset: 3,
      uiLang: "en-US",
    });

    expect(url.searchParams.get("operators")).toBe("true");
    expect(url.searchParams.get("spellcheck")).toBe("false");
    expect(url.searchParams.get("result_filter")).toBe("web,discussions,faq");
    expect(url.searchParams.get("goggles")).toBe("https://example.com/docs.goggle");
    expect(url.searchParams.get("offset")).toBe("3");
    expect(url.searchParams.get("ui_lang")).toBe("en-US");
  });

  it("maps dateRange to freshness and rejects freshness set together", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "range-secret";

    const url = await runSearchCapturingUrl({
      query: "versioned docs",
      dateRange: "2025-01-01to2025-06-30",
    });
    expect(url.searchParams.get("freshness")).toBe("2025-01-01to2025-06-30");

    await expect(
      createSearchTool().execute(
        "call",
        { query: "both", freshness: "week", dateRange: "2025-01-01to2025-06-30" },
        undefined,
        undefined,
      ),
    ).rejects.toThrow("mutually exclusive");
  });

  it("normalizes country ALL to uppercase", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "country-secret";

    const url = await runSearchCapturingUrl({ query: "global docs", country: "ALL" });
    expect(url.searchParams.get("country")).toBe("ALL");
  });

  it("surfaces Brave query metadata as evidence", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "meta-secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          query: {
            altered: "corrected query",
            spellcheck_off: false,
            show_strict_warning: true,
            more_results_available: true,
            search_operators: { applied: true, sites: ["github.com"] },
          },
          web: {
            results: [{ title: "A", url: "https://example.com/a", description: "d" }],
          },
        }),
      ),
    );

    const result = await createSearchTool().execute(
      "call",
      { query: "excat error string", spellcheck: false },
      undefined,
      undefined,
    );

    expect(result.details.evidence.alteredQuery).toBe("corrected query");
    expect(result.details.evidence.spellcheckOff).toBe(false);
    expect(result.details.evidence.showStrictWarning).toBe(true);
    expect(result.details.evidence.moreResultsAvailable).toBe(true);
    expect(result.details.evidence.operatorsApplied).toBe(true);
    expect(result.details.evidence.operatorSites).toEqual(["github.com"]);
  });

  it("validates code-search inputs before contacting the provider", async () => {
    expect(() => normalizeResultFilter("web,discussions,faq")).not.toThrow();
    expect(() => normalizeResultFilter("web,bogus")).toThrow("resultFilter");
    expect(() => normalizeResultFilter("")).toThrow("resultFilter");
    expect(() => normalizeResultFilter("news")).toThrow('must include "web"');
    expect(mapFreshness("week", undefined)).toBe("pw");
    expect(mapFreshness(undefined, "2025-01-01to2025-06-30")).toBe("2025-01-01to2025-06-30");
    expect(() => mapFreshness("week", "2025-01-01to2025-06-30")).toThrow("mutually exclusive");

    expect(() => validateProviderRequest("q", 5, "web", { country: "USA" })).toThrow(
      "2-letter code",
    );
    expect(() => validateProviderRequest("q", 5, "web", { offset: 10 })).toThrow("offset");
    expect(() => validateProviderRequest("q", 5, "web", { dateRange: "last-week" })).toThrow(
      "dateRange",
    );
    expect(() => validateProviderRequest("q", 5, "web", { goggles: "" })).toThrow("goggles");
  });

  it("enforces the web-mode result-count limit at runtime", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "count-secret";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createSearchTool().execute("call", { query: "too many", count: 21 }, undefined, undefined),
    ).rejects.toThrow("between 1 and 20 in web mode");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects context-only options in web mode", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "web-threshold-secret";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createSearchTool().execute(
        "call",
        { query: "web threshold", threshold: "lenient" },
        undefined,
        undefined,
      ),
    ).rejects.toThrow("only supported in context mode");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("web_search context tuning", () => {
  it("passes threshold, depth budgets, and shared options to the context endpoint", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "ctx-secret";

    const url = await runSearchCapturingUrl(
      {
        query: "rare bundler error",
        mode: "context",
        count: 10,
        threshold: "lenient",
        depth: "deep",
        spellcheck: false,
        country: "US",
      },
      { grounding: { generic: [] } },
    );

    expect(url.origin + url.pathname).toBe("https://api.search.brave.com/res/v1/llm/context");
    expect(url.searchParams.get("context_threshold_mode")).toBe("lenient");
    expect(url.searchParams.get("maximum_number_of_tokens")).toBe("16384");
    expect(url.searchParams.get("maximum_number_of_tokens_per_url")).toBe("4096");
    expect(url.searchParams.get("spellcheck")).toBe("false");
    expect(url.searchParams.get("country")).toBe("US");
  });

  it("keeps the quick depth budget as the default", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "ctx-default-secret";

    const url = await runSearchCapturingUrl(
      { query: "default budget", mode: "context" },
      { grounding: { generic: [] } },
    );

    expect(url.searchParams.get("context_threshold_mode")).toBe("strict");
    expect(url.searchParams.get("maximum_number_of_tokens")).toBe("2048");
  });

  it("allows up to 50 results in context mode but not 51", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "ctx-count-secret";
    const fetchMock = vi.fn(async () => jsonResponse({ grounding: { generic: [] } }));
    vi.stubGlobal("fetch", fetchMock);

    await createSearchTool().execute(
      "call",
      { query: "many", mode: "context", count: 50 },
      undefined,
      undefined,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await expect(
      createSearchTool().execute(
        "call",
        { query: "too many", mode: "context", count: 51 },
        undefined,
        undefined,
      ),
    ).rejects.toThrow("between 1 and 50 in context mode");
  });

  it("records threshold and depth in evidence", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "ctx-evidence-secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          grounding: {
            generic: [{ title: "T", url: "https://example.com/t", snippets: ["s"] }],
          },
        }),
      ),
    );

    const result = await createSearchTool().execute(
      "call",
      { query: "evidence", mode: "context", threshold: "balanced", depth: "standard" },
      undefined,
      undefined,
    );

    expect(result.details.evidence.threshold).toBe("balanced");
    expect(result.details.evidence.depth).toBe("standard");
  });
});

describe("web_search code-search schema", () => {
  it("accepts the new options without union shapes", () => {
    expect(
      Check(webSearchParameters, {
        query: "error TS2307 site:github.com",
        operators: false,
        spellcheck: false,
        resultFilter: "web,discussions,faq",
        goggles: "https://example.com/docs.goggle",
        offset: 2,
        uiLang: "en-US",
        dateRange: "2025-01-01to2025-06-30",
      }),
    ).toBe(true);
    expect(
      Check(webSearchParameters, {
        query: "grounding",
        mode: "context",
        threshold: "lenient",
        depth: "deep",
        count: 50,
      }),
    ).toBe(true);
    expect(JSON.stringify(webSearchParameters)).not.toContain("anyOf");
  });
});
