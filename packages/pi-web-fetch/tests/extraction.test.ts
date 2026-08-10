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
});
