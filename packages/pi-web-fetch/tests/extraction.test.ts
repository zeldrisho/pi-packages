import { describe, expect, it, vi } from "vite-plus/test";
import { extractHtmlToMarkdown } from "../src/extract";

describe("HTML extraction", () => {
  it("discards malformed schema.org data without writing through Pi's TUI", async () => {
    const articleText = Array.from({ length: 150 }, (_, index) => `word${index}`).join(" ");
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
    const articleText = Array.from({ length: 150 }, (_, index) => `word${index}`).join(" ");
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

  it("preserves the origin when extracting a GitHub-style host + path URL", async () => {
    // GitHub release pages are full of document-relative links (e.g. `/owner/repo`).
    // If the scheme and host were stripped before reaching Defuddle, it would call
    // `new URL("/voidzero-dev/setup-vp/releases")` with no base and throw
    // ERR_INVALID_URL, surfacing as an unhandled rejection that crashes the harness.
    const words = Array.from({ length: 150 }, (_, index) => `word${index}`);
    words[10] =
      'see <a href="/voidzero-dev/setup-vp">the project</a> and <a href="/login">sign in</a>';
    const html = `<html><head><title>Releases · voidzero-dev/setup-vp</title></head><body><main><article><h1>Releases</h1><p>${words.join(" ")}</p></article></main></body></html>`;

    const result = await extractHtmlToMarkdown(
      html,
      new URL("https://github.com/voidzero-dev/setup-vp/releases"),
    );

    expect(result.extractor).toBe("defuddle");
    expect(result.markdown).toContain("word149");
    // Relative links must resolve against the full origin, proving the absolute
    // URL reached Defuddle instead of a stripped pathname.
    expect(result.markdown).toContain("https://github.com/voidzero-dev/setup-vp");
  });

  it("never propagates a Defuddle failure for a GitHub-style URL", async () => {
    const articleText = Array.from({ length: 150 }, (_, index) => `word${index}`).join(" ");
    const html = `<html><head><title>Releases · voidzero-dev/setup-vp</title></head><body><main><article><h1>Releases</h1><p>${articleText}</p></article></main></body></html>`;

    // Even if Defuddle throws synchronously or schedules a detached rejection
    // after its own promise resolves, extractHtmlToMarkdown must resolve rather
    // than reject, falling back to the basic extractor instead of crashing the UI.
    await expect(
      extractHtmlToMarkdown(html, new URL("https://github.com/voidzero-dev/setup-vp/releases")),
    ).resolves.toMatchObject({
      extractor: expect.stringMatching(/^(defuddle|basic)$/),
    });
  });
});
