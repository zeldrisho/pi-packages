import { describe, expect, it, vi } from "vite-plus/test";
import { summarizeDomainDiversity } from "../src/search";
import { createSearchTool, jsonResponse } from "./harness";

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
              { title: "A", url: "https://example.com/a", description: "x".repeat(80) },
              { title: "Title only", url: "https://example.com/b", description: "" },
              { title: "", url: "https://example.com/c", description: "Snippet only" },
              { title: "", url: "https://example.com/d", description: "" },
            ],
          },
        }),
      ),
    );

    const result = await createSearchTool().execute(
      "call",
      { query: "evidence query", count: 4 },
      undefined,
      undefined,
    );

    expect(result.details.evidence).toEqual({
      requestedCount: 4,
      returnedCount: 4,
      dropped: 0,
      truncated: false,
      uniqueDomains: 1,
      topDomainShare: 1,
    });
    expect(result.details.results.map((item) => item.quality)).toEqual([
      "high",
      "medium",
      "medium",
      "low",
    ]);
  });
});
