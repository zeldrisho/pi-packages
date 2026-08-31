import { describe, expect, it, vi } from "vite-plus/test";
import { classifyResultQuality } from "../src/brave";
import { summarizeDomainDiversity } from "../src/search";
import { createSearchTool, jsonResponse } from "./harness";

describe("classifyResultQuality", () => {
  it("flags snippet-rich results as high", () => {
    expect(classifyResultQuality({ title: "T", snippet: "x".repeat(80) })).toBe("high");
  });

  it("flags title-or-snippet results as medium", () => {
    expect(classifyResultQuality({ title: "T", snippet: "" })).toBe("medium");
    expect(classifyResultQuality({ title: "", snippet: "short" })).toBe("medium");
  });

  it("flags empty results as low", () => {
    expect(classifyResultQuality({ title: "", snippet: "" })).toBe("low");
  });
});

describe("search domain diversity", () => {
  it("normalizes www hosts and reports the dominant-domain share", () => {
    expect(
      summarizeDomainDiversity([
        { title: "A", url: "https://www.example.com/a", snippet: "", quality: "medium" },
        { title: "B", url: "https://example.com/b", snippet: "", quality: "medium" },
        { title: "C", url: "https://other.example/c", snippet: "", quality: "medium" },
        { title: "D", url: "not a URL", snippet: "", quality: "medium" },
      ]),
    ).toEqual({ uniqueDomains: 2, topDomainShare: 0.5 });
  });

  it("reports zero diversity for no results", () => {
    expect(summarizeDomainDiversity([])).toEqual({ uniqueDomains: 0, topDomainShare: 0 });
  });
});

describe("web_search honest-evidence details", () => {
  it("reports requested vs returned counts and per-result quality", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "evidence-secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          web: {
            results: [
              { title: "A", url: "https://example.com/a", description: "x".repeat(120) },
              { title: "B", url: "https://example.com/b", description: "short" },
              { title: "", url: "https://example.com/c", description: "" },
            ],
          },
        }),
      ),
    );

    const result = await createSearchTool().execute(
      "call",
      { query: "evidence query", count: 3 },
      undefined,
      undefined,
    );

    expect(result.details.evidence).toEqual({
      requestedCount: 3,
      returnedCount: 3,
      dropped: 0,
      freshness: undefined,
      truncated: false,
      uniqueDomains: 1,
      topDomainShare: 1,
    });
    expect(result.details.results.map((item) => item.quality)).toEqual(["high", "medium", "low"]);
  });

  it("surfaces when Brave returns fewer results than requested", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "fewer-secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          web: {
            results: [{ title: "Only", url: "https://example.com/only", description: "one" }],
          },
        }),
      ),
    );

    const result = await createSearchTool().execute(
      "call",
      { query: "fewer", count: 5 },
      undefined,
      undefined,
    );

    expect(result.details.evidence.requestedCount).toBe(5);
    expect(result.details.evidence.returnedCount).toBe(1);
    expect(result.details.evidence.dropped).toBe(0);
  });

  it("includes freshness in the evidence summary", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "fresh-secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          web: { results: [{ title: "T", url: "https://example.com/t", description: "d" }] },
        }),
      ),
    );

    const result = await createSearchTool().execute(
      "call",
      { query: "fresh", count: 1, freshness: "week" },
      undefined,
      undefined,
    );

    expect(result.details.evidence.freshness).toBe("week");
  });
});
