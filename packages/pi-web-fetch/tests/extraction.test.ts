import { describe, expect, it, vi } from "vite-plus/test";
import type { DefuddleResponse } from "defuddle/node";
import {
  extractHtmlToMarkdown,
  htmlToMarkdownFallback,
  stripExtractedCssCruft,
} from "../src/document/extract.ts";
import { exceedsConversionDepth, MAX_CONVERSION_DEPTH } from "../src/document/complexity.ts";

// Mock defuddle/node so we can induce failures. The factory keeps the real
// implementation by default (the other tests exercise the real extractor) and
// lets individual tests override `Defuddle` to simulate rejections.
vi.mock("defuddle/node", async () => {
  const actual = await vi.importActual<typeof import("defuddle/node")>("defuddle/node");

  return { ...actual, Defuddle: vi.fn(actual.Defuddle) };
});

const articleHtml = (text: string): string =>
  `<html><head><title>Fixture</title></head><body><main><article><h1>Fixture</h1><p>${text}</p></article></main></body></html>`;

const longText = (): string => Array.from({ length: 150 }, (_, index) => `word${index}`).join(" ");

describe("extracted CSS cleanup", () => {
  it("removes leaked style elements and standalone CSS rules", () => {
    const markdown = [
      "# Guide",
      "<style>",
      ".hidden { display: none; }",
      "</style>",
      ".mw-parser-output .infobox { float: right; margin: 0; }",
      "Readable prose remains.",
    ].join("\n");

    expect(stripExtractedCssCruft(markdown)).toBe("# Guide\n\nReadable prose remains.");
  });

  it("does not recreate style elements when nested fragments are removed", () => {
    const markdown = "Before.\n<sty<style>discard</style>le>discard</style>\nAfter.";

    expect(stripExtractedCssCruft(markdown)).toBe("Before.\n\nAfter.");
  });

  it("does not close a longer fence with a shorter or suffixed delimiter", () => {
    const markdown = [
      "````css",
      ".first { display: block; }",
      "```",
      ".second { display: block; }",
      "```` not a close",
      ".third { display: block; }",
      "````",
      ".outside { display: none; }",
    ].join("\n");

    expect(stripExtractedCssCruft(markdown)).toBe(markdown.split("\n").slice(0, -1).join("\n"));
  });

  it("removes nested block at-rules", () => {
    const markdown = [
      "Before.",
      "@media (min-width: 40rem) {",
      "  .card { display: grid; }",
      "}",
      "After.",
    ].join("\n");

    expect(stripExtractedCssCruft(markdown)).toBe("Before.\nAfter.");
  });

  it("preserves fenced stylesheet examples and prose mentioning CSS", () => {
    const markdown = [
      "Use @media queries for responsive layouts.",
      "",
      "```css",
      ".card { display: grid; }",
      "@media (min-width: 40rem) { .card { grid-template-columns: 1fr 1fr; } }",
      "```",
    ].join("\n");

    expect(stripExtractedCssCruft(markdown)).toBe(markdown);
  });

  it("is idempotent", () => {
    const markdown = "Intro.\n.foo { color: red; }\nOutro.";
    const cleaned = stripExtractedCssCruft(markdown);

    expect(stripExtractedCssCruft(cleaned)).toBe(cleaned);
  });
});

describe("HTML extraction", () => {
  it("maps section wrapper fragments to retained content when the heading is omitted", async () => {
    const result = await extractHtmlToMarkdown(
      `<main><div id="intro"><p>${longText()}</p></div><div id="install"><h1>Installation</h1><p>Before you can run hooks, install the pre-commit package manager.</p><pre>pip install pre-commit</pre></div></main>`,
      new URL("https://example.com/guide"),
    );

    const offset = result.fragmentOffsets?.install;
    expect(offset).toBeDefined();
    expect(result.markdown.slice(offset)).toContain("Before you can run hooks");
  });

  it("records fragment offsets for headings and explicit anchors", async () => {
    const result = await extractHtmlToMarkdown(
      `<main><h1>Guide</h1><h2 id="get-started">Get started</h2><p>Install it.</p><h2>Next steps</h2></main>`,
      new URL("https://example.com/guide"),
    );

    const offset = result.fragmentOffsets?.["get-started"];
    expect(offset).toBeDefined();
    expect(result.markdown.slice(offset)).toMatch(/^#+ Get started/m);
  });

  it("strips markup before generating fragment slugs", async () => {
    const result = await extractHtmlToMarkdown(
      `<main><article><h1>Guide</h1><h2 id="markup-heading"><em>Markup</em> heading</h2><p>${longText()}</p></article></main>`,
      new URL("https://example.com/guide"),
    );

    const offset = result.fragmentOffsets?.["markup-heading"];
    expect(offset).toBeDefined();
    expect(result.markdown.slice(offset)).toMatch(/^#+ Markup heading/m);
  });

  it("discards malformed schema.org data without writing through Pi's TUI", async () => {
    const articleText = longText();

    const html = `<html><head><title>Fixture</title><script type="application/ld+json">{"@type":"Article","description":"invalid
schema"}</script></head><body><main><article><h1>Fixture</h1><p>${articleText}</p></article></main></body></html>`;

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const result = await extractHtmlToMarkdown(html, new URL("https://example.com/article"));

      expect(result.extractor).toBe("defuddle");
      expect(result.markdown).toContain("word149");
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("normalizes IDs that Defuddle cannot safely use in generated selectors", async () => {
    const articleText = longText();
    const html = `<html><head><title>Fixture</title></head><body><div id="defuddle-safe-id-0">Existing ID</div><main><article><h1>Fixture</h1><p>This is the <a href="#P:1">target link</a>. ${articleText}</p><h2 id="P:1">Target heading</h2><p>${articleText}</p></article></main></body></html>`;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const result = await extractHtmlToMarkdown(html, new URL("https://example.com/article"));

      expect(result.extractor).toBe("defuddle");
      expect(result.markdown).toContain("word149");
      expect(result.markdown).toContain("[target link](#defuddle-safe-id-1)");
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("preserves original unsafe IDs in fragment offsets", async () => {
    const html = `<main><h1>Fixture</h1><h2 id="1">Numeric heading</h2><p>${longText()}</p></main>`;
    const result = await extractHtmlToMarkdown(html, new URL("https://example.com/article"));

    const offset = result.fragmentOffsets?.["1"];
    expect(offset).toBeDefined();
    expect(result.markdown.slice(offset)).toMatch(/^#+ Numeric heading/m);
  });

  it("preserves the origin when extracting a GitHub-style host + path URL", async () => {
    // GitHub release pages are full of document-relative links (e.g. `/owner/repo`).
    // If the scheme and host were stripped before reaching Defuddle, it would call
    // `new URL("/voidzero-dev/setup-vp/releases")` with no base and throw
    // ERR_INVALID_URL, surfacing as an unhandled rejection that crashes the harness.
    const words = Array.from({ length: 150 }, (_, index) => `word${index}`);
    words[10] =
      'see <a href="/voidzero-dev/setup-vp">the project</a> and <a href="/login">sign in</a>';
    const html = `<html><head><title>Releases · voidzero-dev/setup-vp</title><meta property="og:url" content="/voidzero-dev/setup-vp/releases"></head><body><main><article><h1>Releases</h1><p>${words.join(" ")}</p></article></main></body></html>`;
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const result = await extractHtmlToMarkdown(
        html,
        new URL("https://github.com/voidzero-dev/setup-vp/releases"),
      );

      expect(result.extractor).toBe("defuddle");
      expect(result.markdown).toContain("word149");
      // Relative links must resolve against the full origin, proving the absolute
      // URL reached Defuddle instead of a stripped pathname.
      expect(result.markdown).toContain("https://github.com/voidzero-dev/setup-vp");
      expect(consoleWarn).not.toHaveBeenCalled();
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it("ignores malformed page URL metadata without abandoning Defuddle", async () => {
    const html = `<html><head><title>Fixture</title><meta property="og:url" content="http://["><link rel="canonical" href="http://["></head><body><main><article><h1>Fixture</h1><p>${longText()}</p></article></main></body></html>`;

    const result = await extractHtmlToMarkdown(html, new URL("https://example.com/article"));

    expect(result.extractor).toBe("defuddle");
    expect(result.markdown).toContain("word149");
  });

  it("falls back to the basic extractor when Defuddle rejects", async () => {
    const { Defuddle } = await import("defuddle/node");
    vi.mocked(Defuddle).mockRejectedValueOnce(new Error("defuddle boom"));

    const result = await extractHtmlToMarkdown(
      articleHtml(longText()),
      new URL("https://example.com/article"),
    );

    expect(result.extractor).toBe("basic");
    expect(result.markdown).toContain("word149");
  });

  it("falls back when Defuddle schedules a detached rejection after resolving", async () => {
    const { Defuddle } = await import("defuddle/node");
    // Resolve successfully, then schedule a detached rejection (simulating Defuddle
    // throwing on a delayed timer after its promise has already resolved).
    vi.mocked(Defuddle).mockImplementation(async () => {
      setImmediate(() => {
        void Promise.reject(new Error("defuddle detached failure"));
      });

      // SAFETY: mock fixture only needs `content`/`title`; remaining DefuddleResponse
      // fields are unused by the caller.
      return { content: "ignored", title: "x" } as DefuddleResponse;
    });

    const result = await extractHtmlToMarkdown(
      articleHtml(longText()),
      new URL("https://example.com/article"),
    );

    expect(result.extractor).toBe("basic");
  });

  it("does not fall back when an unrelated rejection occurs during extraction", async () => {
    // Defuddle succeeds; meanwhile unrelated concurrent work rejects. The guard
    // must ignore that rejection (it does not mention Defuddle) and must not
    // force a spurious fallback to the basic extractor.
    const swallow = (): void => {};

    process.once("unhandledRejection", swallow);
    const { Defuddle } = await import("defuddle/node");
    vi.mocked(Defuddle).mockImplementation(async () => {
      // Schedule a concurrent, unrelated rejection. setImmediate registers it
      // during this call, while the guard's listener is still armed, so it is
      // observed but must be ignored (it does not mention Defuddle).
      setImmediate(() => {
        void Promise.reject(new Error("unrelated concurrent failure"));
      });

      // SAFETY: mock fixture only needs `content`/`title`; remaining DefuddleResponse
      // fields are unused by the caller.
      return { content: "word149", title: "Fixture" } as DefuddleResponse;
    });

    try {
      const result = await extractHtmlToMarkdown(
        articleHtml(longText()),
        new URL("https://example.com/article"),
      );

      expect(result.extractor).toBe("defuddle");
      expect(result.markdown).toContain("word149");
    } finally {
      process.off("unhandledRejection", swallow);
    }
  });
});

describe("conversion depth bounds", () => {
  const nestedHtml = (depth: number): string =>
    `<div>${"<div>".repeat(depth)}Readable leaf${"</div>".repeat(depth)}</div>`;

  it("detects markup beyond the conversion depth ceiling", () => {
    expect(exceedsConversionDepth(nestedHtml(10))).toBe(false);
    expect(exceedsConversionDepth(nestedHtml(513))).toBe(true);
  });

  it("preserves scanner indices after Unicode text", () => {
    const shallow = `İ${nestedHtml(10)}`.repeat(MAX_CONVERSION_DEPTH + 1);
    const deep = `İİİ${"br<ab>".repeat(MAX_CONVERSION_DEPTH + 1)}`;

    expect(exceedsConversionDepth(shallow)).toBe(false);
    expect(exceedsConversionDepth(deep)).toBe(true);
    expect(exceedsConversionDepth("İ<DIV>leaf</DIV>".repeat(600))).toBe(false);
  });

  it("ignores comments, void elements, and raw-text bodies", () => {
    const comment = `<!-- ${"<div>".repeat(600)} --><p>Visible</p>`;
    const voids = `${"<br>".repeat(600)}<img src="x"><p>Visible</p>`;
    const script = `<script>${"<div>".repeat(600)}</script><p>Visible</p>`;

    expect(exceedsConversionDepth(comment)).toBe(false);
    expect(exceedsConversionDepth(voids)).toBe(false);
    expect(exceedsConversionDepth(script)).toBe(false);
  });

  it.each(['<div x=a">', "<div x=a'>", '<div x=a=" >', "<div x=a=' >"])(
    "does not let quotes inside unquoted attributes hide nesting: %s",
    (tag) => {
      expect(exceedsConversionDepth(tag.repeat(MAX_CONVERSION_DEPTH + 1))).toBe(true);
    },
  );

  it.each(['"', "'"])("preserves properly quoted attribute values: %s", (quote) => {
    const value = `> ${"<div>".repeat(MAX_CONVERSION_DEPTH + 1)}`;
    const html = `<div x= \t\n\f\r${quote}${value}${quote} y=unquoted z=${quote}${value}${quote}>leaf</div>`;

    expect(exceedsConversionDepth(html)).toBe(false);
  });

  it("accepts the exact ceiling and refuses the next opening element", () => {
    expect(exceedsConversionDepth("<div>".repeat(MAX_CONVERSION_DEPTH))).toBe(false);
    expect(exceedsConversionDepth("<div>".repeat(MAX_CONVERSION_DEPTH + 1))).toBe(true);
  });

  it.each([
    "<div/>".repeat(600),
    `<noscript>${nestedHtml(600)}</noscript>`,
    `<div data-value="quoted > text">${nestedHtml(600)}</div>`,
    "<div><span></div>".repeat(600),
  ])("does not let malformed or self-closing markup hide nesting", (html) => {
    expect(exceedsConversionDepth(html)).toBe(true);
  });

  it("refuses hostile nesting before either DOM extractor is called", async () => {
    const html = nestedHtml(20_000);
    const { Defuddle } = await import("defuddle/node");
    const previousCalls = vi.mocked(Defuddle).mock.calls.length;

    await expect(
      extractHtmlToMarkdown(html, new URL("https://example.com/hostile")),
    ).rejects.toThrow("HTML nesting exceeds the safe extraction depth (512)");
    expect(() => htmlToMarkdownFallback(html)).toThrow("safe extraction depth");
    expect(vi.mocked(Defuddle).mock.calls).toHaveLength(previousCalls);
  });
});
