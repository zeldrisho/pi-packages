import { describe, expect, it } from "vite-plus/test";
import { focusMarkdown } from "../src/focus";

describe("query-focused Markdown", () => {
  it("selects matching sections while preserving source order", () => {
    const markdown = [
      "# Installation\n\nInstall the package with Vite+.",
      "# Cache policy\n\nCached pages expire after one day.",
      "# Redirects\n\nEvery redirect target is validated.",
      "# Cache revalidation\n\nValidators can avoid downloading unchanged pages.",
    ].join("\n\n");

    const result = focusMarkdown(markdown, "cache validators");

    expect(result.markdown).toContain("# Cache policy");
    expect(result.markdown).toContain("# Cache revalidation");
    expect(result.markdown).not.toContain("# Installation");
    expect(result.markdown).not.toContain("# Redirects");
    expect(result.markdown.indexOf("Cache policy")).toBeLessThan(
      result.markdown.indexOf("Cache revalidation"),
    );
    expect(result.details).toMatchObject({
      query: "cache validators",
      matchedSections: 2,
      totalSections: 4,
      omittedSections: 2,
    });
  });

  it("uses paragraphs as sections for headingless content", () => {
    const result = focusMarkdown(
      "Alpha covers installation.\n\nBeta explains cancellation.\n\nGamma covers cleanup.",
      "cancellation",
    );

    expect(result.markdown).toBe("Beta explains cancellation.");
    expect(result.details.matchedSections).toBe(1);
  });

  it("returns honest empty evidence when no section matches", () => {
    const result = focusMarkdown("# Alpha\n\nOnly alpha is discussed.", "unrelated");

    expect(result.markdown).toBe("");
    expect(result.details).toMatchObject({ matchedSections: 0, totalSections: 1 });
  });

  it("matches case-insensitively and deduplicates repeated query terms", () => {
    const once = focusMarkdown("First paragraph.\n\nCaching is bounded.", "CACHE caching caching");

    expect(once.markdown).toBe("Caching is bounded.");
    expect(once.details.matchedSections).toBe(1);
  });
});
