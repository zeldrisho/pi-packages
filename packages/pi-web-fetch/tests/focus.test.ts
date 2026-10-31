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

  it("recognizes headings between separate fenced blocks", () => {
    const markdown = "```js\nfirst\n```\n# Heading\nneedle\n```\nsecond\n```";
    const result = focusMarkdown(markdown, "needle");

    expect(result.details.totalSections).toBe(2);
    expect(result.markdown).toContain("# Heading");
    expect(result.markdown).not.toContain("first");
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

  it("matches dotted filenames literally instead of selecting common components", () => {
    const markdown = [
      '<h2 id="intro">Morphe introduction</h2>\n\nMorphe runs applications.',
      '<h2 id="storage">Storage</h2>\n\nThe default is `morphe.keystore`.',
      '<h2 id="other">Other</h2>\n\nMorphe supports a different keystore.',
    ].join("\n\n");

    const result = focusMarkdown(markdown, "morphe.keystore");
    expect(result.details).toMatchObject({ matchedSections: 1, totalSections: 3 });
    expect(result.markdown).toContain("morphe.keystore");
    expect(result.markdown).not.toContain("introduction");
    expect(result.markdown).not.toContain("different keystore");
  });

  it("splits oversized headed sections without breaking fenced blocks", () => {
    const markdown =
      `# Large\n\n${"Background text. ".repeat(600)}\n\n` +
      "```text\nneedle\n\ncode\n```\n\n# Other\n\nNothing relevant.";

    const result = focusMarkdown(markdown, "needle");
    expect(result.markdown).toContain("```text\nneedle\n\ncode\n```");
    expect(result.markdown).not.toContain("Background text");
    expect(result.markdown).not.toContain("# Other");
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

  it("matches identifiers and punctuation literally without falling back to components", () => {
    const markdown =
      "# A\nnotmorphe.keystore.bak\n# B\nMorphe keystore\n# C\nerror-startup and -- flags.";

    expect(focusMarkdown(markdown, "morphe.keystore").markdown).toBe("");
    expect(focusMarkdown(markdown, "error-startup").markdown).toContain("# C");
    expect(focusMarkdown(markdown, "--").markdown).toContain("# C");
    expect(focusMarkdown("Use morphe.keystore.", "morphe.keystore").markdown).toContain("keystore");
  });

  it("finds common word inflections", () => {
    expect(focusMarkdown("Cached pages expire.", "caching").markdown).toContain("Cached");
  });

  it("focuses long single-line paragraphs and mixed fences", () => {
    const long = focusMarkdown(`# API\n${"unrelated ".repeat(900)}needle here`, "needle");
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

  it("finds matches in medium-sized headingless paragraphs", () => {
    const markdown = `${"unrelated ".repeat(700)} needle`;
    const result = focusMarkdown(markdown, "needle");
    expect(result.markdown.indexOf("needle")).toBeLessThan(6000);
  });

  it.each([
    [
      "grammy commands",
      "bot.command",
      "## Commands\n\nUse `bot.command` for handlers.\n\n## Menus\n\nConfigure menus.",
      "Use `bot.command`",
      "Configure menus",
    ],
    [
      "admin provider",
      "dataProvider",
      "## Provider\n\nSet the `dataProvider` prop.\n\n## Theme\n\nChoose colors.",
      "dataProvider",
      "Choose colors",
    ],
    [
      "worker cron",
      "scheduled handler",
      "## Cron\n\nUse a scheduled handler for cron triggers.\n\n## HTTP\n\nHandle requests.",
      "scheduled handler",
      "Handle requests",
    ],
    [
      "D1 API",
      "env.DB.prepare",
      "## D1\n\n```js\nenv.DB.prepare(sql)\n```\n\n## KV\n\nUse KV.",
      "env.DB.prepare",
      "Use KV",
    ],
    [
      "package catalog",
      "web fetch",
      "### pi-web-access\n\nWeb search and fetch tools.\n\n### pi-theme\n\nA theme.",
      "pi-web-access",
      "pi-theme",
    ],
  ])("focuses representative %s documentation", (_name, query, markdown, expected, omitted) => {
    const result = focusMarkdown(markdown, query);
    expect(result.markdown).toContain(expected);
    expect(result.markdown).not.toContain(omitted);
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
