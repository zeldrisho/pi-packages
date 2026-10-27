import { describe, expect, it } from "vite-plus/test";
import { focusMarkdown } from "../src/document/focus.ts";

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

  it("starts a section at every heading without requiring blank lines", () => {
    const result = focusMarkdown(
      "# Cache\nCaching is bounded.\n# Redirects\nRedirect targets are validated.",
      "caching",
    );

    expect(result.markdown).toBe("# Cache\nCaching is bounded.");
    expect(result.details).toMatchObject({ matchedSections: 1, totalSections: 2 });
  });

  it("uses paragraphs as sections for headingless content", () => {
    const result = focusMarkdown(
      "Alpha covers installation.\n\nBeta explains cancellation.\n\nGamma covers cleanup.",
      "cancellation",
    );

    expect(result.markdown).toBe("Beta explains cancellation.");
    expect(result.details.matchedSections).toBe(1);
  });

  it("returns balanced fenced windows with indentation and source order", () => {
    const lines = Array.from(
      { length: 400 },
      (_, i) => `  ${i === 150 ? "needle" : i === 350 ? "needle" : "entry"} ${i} ${"x".repeat(80)}`,
    );

    const result = focusMarkdown(`\`\`\`json\r\n${lines.join("\r\n")}\r\n\`\`\``, "needle");
    expect(result.details.totalSections).toBeGreaterThan(2);
    expect(result.details.matchedSections).toBe(2);
    expect(result.markdown.match(/```json/g)).toHaveLength(2);
    expect(result.markdown.match(/```/g)).toHaveLength(4);
    expect(result.markdown).toContain("  needle 150");
    expect(result.markdown.indexOf("needle 150")).toBeLessThan(
      result.markdown.indexOf("needle 350"),
    );
    expect(focusMarkdown(`\`\`\`json\n${lines.join("\n")}\n\`\`\``, "absent").markdown).toBe("");
  });

  it("handles long whitespace after a closing fence followed by non-whitespace", () => {
    const markdown = `\`\`\`json\nneedle\n\`\`\`${"\t".repeat(100_000)}x`;
    expect(focusMarkdown(markdown, "needle").markdown).toContain("needle");
  });

  it("does not treat code inside fences as headings", () => {
    const result = focusMarkdown(
      "# Real\n\n```yaml\n# fake\nvalue: needle\n```\n# Other\nother",
      "needle",
    );

    expect(result.details.totalSections).toBe(2);
    expect(result.markdown).toContain("# Real");
    expect(result.markdown).not.toContain("# Other");
  });

  it("windows long headingless paragraphs even when other paragraphs exist", () => {
    const long = Array.from(
      { length: 300 },
      (_, i) => `  ${i === 150 ? "needle" : "entry"} ${i} ${"x".repeat(80)}`,
    ).join("\n");

    const result = focusMarkdown(`intro paragraph\n\n${long}\n\nclosing paragraph`, "needle");
    expect(result.details.totalSections).toBeGreaterThan(3);
    expect(result.markdown).toContain("  needle 150");
    expect(result.markdown).not.toContain("closing paragraph");
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
