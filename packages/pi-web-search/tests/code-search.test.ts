import { describe, expect, it, vi } from "vite-plus/test";
import { normalizeResultFilter, validateProviderRequest } from "../src/brave";
import { createSearchTool, jsonResponse } from "./harness";

vi.mock("../src/credentials", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/credentials")>();

  return {
    ...actual,
    resolveApiKey: (cwd: string, keyName?: "BRAVE_SEARCH_API_KEY" | "BRAVE_ANSWERS_API_KEY") =>
      keyName === "BRAVE_ANSWERS_API_KEY" ? undefined : actual.resolveApiKey(cwd, keyName),
  };
});

describe("web_search code-search options", () => {
  it("passes web options without a spellcheck override", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "code-secret";

    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      jsonResponse({ web: { results: [] } }),
    );

    vi.stubGlobal("fetch", fetchMock);
    await createSearchTool().execute(
      "call",
      {
        query: "site:github.com filetype:pdf intitle:vite",
        operators: true,
        resultFilter: "web,discussions,faq",
        goggles: "https://example.com/docs.goggle",
        offset: 3,
        uiLang: "en-US",
        country: "ALL",
        dateRange: "2025-01-01to2025-06-30",
      },
      undefined,
      undefined,
    );
    const input = fetchMock.mock.calls[0]![0];
    const url = new URL(input instanceof Request ? input.url : input.toString());
    expect(url.searchParams.get("operators")).toBe("true");
    expect(url.searchParams.has("spellcheck")).toBe(false);
    expect(url.searchParams.get("result_filter")).toBe("web,discussions,faq");
    expect(url.searchParams.get("goggles")).toBe("https://example.com/docs.goggle");
    expect(url.searchParams.get("offset")).toBe("3");
    expect(url.searchParams.get("ui_lang")).toBe("en-US");
    expect(url.searchParams.get("country")).toBe("ALL");
    expect(url.searchParams.get("freshness")).toBe("2025-01-01to2025-06-30");
  });

  it("retains echoed query metadata without exposing spellcheck as a parameter", async () => {
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
          web: { results: [] },
        }),
      ),
    );

    const result = await createSearchTool().execute(
      "call",
      { query: "excat error string" },
      undefined,
      undefined,
    );

    expect(result.details.evidence).toMatchObject({
      alteredQuery: "corrected query",
      spellcheckOff: false,
      showStrictWarning: true,
      moreResultsAvailable: true,
      operatorsApplied: true,
      operatorSites: ["github.com"],
    });
    expect(result.structuredContent).toMatchObject({
      evidence: result.details.evidence,
    });
  });

  it("validates advanced inputs", () => {
    expect(() => normalizeResultFilter("web,discussions,faq")).not.toThrow();

    for (const value of ["web,bogus", "", "news"])
      expect(() => normalizeResultFilter(value)).toThrow("resultFilter");
    expect(() => validateProviderRequest("q", 5, "web", { country: "USA" })).toThrow(
      "2-letter code",
    );
    expect(() => validateProviderRequest("q", 5, "web", { offset: 10 })).toThrow("offset");
    expect(() => validateProviderRequest("q", 5, "web", { dateRange: "last-week" })).toThrow(
      "dateRange",
    );
    expect(() => validateProviderRequest("q", 5, "web", { goggles: "" })).toThrow("goggles");
  });

  it("rejects excessive web counts", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      createSearchTool().execute("call", { query: "too many", count: 21 }, undefined, undefined),
    ).rejects.toThrow("between 1 and 20 in web mode");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("web_search recovery guidance", () => {
  it.each([0, 1, 2, 5])("reports %s of 5 results without automatic fallback", async (count) => {
    process.env.BRAVE_SEARCH_API_KEY = "guidance-secret";
    delete process.env.BRAVE_ANSWERS_API_KEY;

    const fetchMock = vi.fn(async () =>
      jsonResponse({
        web: {
          results: Array.from({ length: count }, (_, index) => ({
            title: `Result ${index}`,
            url: `https://example.com/${index}`,
            description: "Evidence",
          })),
        },
      }),
    );

    vi.stubGlobal("fetch", fetchMock);
    const tool = createSearchTool();
    const params = { query: `guidance ${count}` };
    const result = await tool.execute("call", params, undefined, undefined);
    const text = result.content[0]!.text;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(text).not.toContain("context");
    expect(text).not.toContain("_Provider:");

    if (count === 0) {
      expect(text).toContain("No web results found");
      expect(text).toContain("No results do not prove absence");
    } else if (count < 5) {
      expect(text).toContain(`Returned ${count} of 5 requested results.`);
      expect(text.match(/If evidence is insufficient/g)).toHaveLength(1);
      expect(text.indexOf("Returned")).toBeLessThan(text.indexOf("1. ["));
    } else expect(text).not.toContain("If evidence is insufficient");
    const cached = await tool.execute("cached", params, undefined, undefined);
    expect(cached.content).toEqual(result.content);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
