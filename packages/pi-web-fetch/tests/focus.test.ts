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

  it("recognizes headings between fenced blocks but not inside them", () => {
    const result = focusMarkdown(
      "```js\nfirst\n```\n# Real\n\n```yaml\n# fake\nvalue: needle\n```\n# Other\nother",
      "needle",
    );

    expect(result.details.totalSections).toBe(3);
    expect(result.markdown).toBe("# Real\n\n```yaml\n# fake\nvalue: needle\n```");
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

  it("retains the heading when only a later chunk of a long section matches", () => {
    const markdown =
      `# Cache policy\n\n${"Background text. ".repeat(600)}\n\n` +
      "```text\nneedle\n\ncode\n```\n\n# Other\n\nNothing relevant.";

    const result = focusMarkdown(markdown, "needle");

    expect(result.markdown).toBe("# Cache policy\n\n```text\nneedle\n\ncode\n```");
    expect(result.markdown).not.toContain("Background text");
    expect(result.details.focusedCharacters).toBe(result.markdown.length);
  });

  it("does not repeat an oversized heading as context", () => {
    const heading = `# ${"background ".repeat(600)}`;
    const result = focusMarkdown(`${heading}\n\nneedle`, "needle");

    expect(result.markdown).toBe("needle");
  });

  it("does not repeat a heading when multiple chunks of a section match", () => {
    const markdown =
      `# Cache needle\n\n${"needle background. ".repeat(300)}\n\n` +
      `${"needle details. ".repeat(300)}\n\n# Other\n\nNothing relevant.`;

    const result = focusMarkdown(markdown, "needle");

    expect(result.details.matchedSections).toBeGreaterThan(1);
    expect(result.markdown.match(/# Cache needle/g)).toHaveLength(1);
    expect(result.markdown.indexOf("background")).toBeLessThan(result.markdown.indexOf("details"));
  });

  it("matches single-character identifiers", () => {
    expect(
      focusMarkdown("# R\n\nR language.\n\n# Python\n\nPython language.", "R").markdown,
    ).toContain("R language");
  });

  it("ignores common words and prefers more relevant sections", () => {
    const result = focusMarkdown(
      "# A\nHow to install.\n# B\nHow to configure cache.\n# C\nHow to uninstall.",
      "how to configure cache",
    );

    expect(result.markdown).toContain("# B");
    expect(result.markdown).not.toContain("# A");
    expect(result.markdown).not.toContain("# C");
  });

  it("omits weaker matching sections below half the best score", () => {
    const result = focusMarkdown(
      "# Strong\ncache validator policy cache validator policy\n# Weak\ncache unrelated unrelated unrelated unrelated unrelated unrelated unrelated unrelated",
      "cache validator policy",
    );

    expect(result.markdown).toContain("# Strong");
    expect(result.markdown).not.toContain("# Weak");
    expect(result.details).toMatchObject({
      matchedSections: 1,
      totalSections: 2,
      omittedSections: 1,
    });
  });

  it("matches identifiers and punctuation literally without falling back to components", () => {
    const markdown = [
      '<h2 id="similar">Similar</h2>\n\nnotmorphe.keystore.bak',
      '<h2 id="other">Other</h2>\n\nMorphe supports a different keystore.',
      '<h2 id="target">Target</h2>\n\nUse `morphe.keystore` for error-startup and -- flags.',
    ].join("\n\n");

    const result = focusMarkdown(markdown, "morphe.keystore");
    expect(result.details).toMatchObject({ matchedSections: 1, totalSections: 3 });
    expect(result.markdown).toContain('id="target"');
    expect(result.markdown).not.toContain("different keystore");
    expect(result.markdown).not.toContain("notmorphe.keystore.bak");
    expect(focusMarkdown(markdown, "error-startup").markdown).toContain('id="target"');
    expect(focusMarkdown(markdown, "--").markdown).toContain('id="target"');
  });

  it("matches dotted identifiers literally inside natural-language queries", () => {
    const markdown = [
      "# Unrelated\n\nHow to prepare the database in your environment.",
      "# API\n\nCall `env.DB.prepare` to create a statement.",
      "# Similar\n\nCall `env.DB.prepareBatch` for many statements.",
    ].join("\n\n");

    const result = focusMarkdown(markdown, "how to use env.DB.prepare");
    expect(result.markdown).toContain("# API");
    expect(result.markdown).not.toContain("# Unrelated");
    expect(result.markdown).not.toContain("# Similar");
    expect(focusMarkdown("# Other\nUse env.DB.prepareBatch.", "use env.DB.prepare").markdown).toBe(
      "",
    );
  });

  it("does not treat ordinary abbreviations in questions as API identifiers", () => {
    expect(
      focusMarkdown("# Cache\nCache expiration policy.", "cache expiration e.g. policy").markdown,
    ).toContain("Cache expiration");
  });

  it("matches singulars and plurals in either direction without matching similar words", () => {
    expect(focusMarkdown("# Target\nprocesses\n# Other\nprocedures", "process").markdown).toBe(
      "# Target\nprocesses",
    );
    expect(focusMarkdown("# Target\nstring\n# Other\nstripes", "strings").markdown).toBe(
      "# Target\nstring",
    );
    expect(focusMarkdown("Target: archives", "archive").markdown).toContain("archives");
  });

  it("focuses long single-line paragraphs and mixed fences", () => {
    const long = focusMarkdown(`# API\n${"unrelated ".repeat(900)}needle here`, "needle");
    expect(long.markdown).toContain("needle here");
    expect(long.markdown.indexOf("needle")).toBeLessThan(6000);
    const mixed = focusMarkdown("Introduction.\n\n```js\ncode\n```\n\nneedle here", "needle");
    expect(mixed.markdown).toBe("needle here");
  });

  it("preserves identifiers across window boundaries", () => {
    const identifier = "env.DB.prepare";
    const line = `${"x ".repeat(1998)}${identifier} ${"y ".repeat(2000)}`;

    for (const markdown of [line, `# API\n\n${line}`, `\`\`\`js\n${line}\n\`\`\``]) {
      expect(focusMarkdown(markdown, identifier).markdown).toContain(identifier);
    }
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
