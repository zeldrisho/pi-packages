import { describe, expect, it, vi } from "vite-plus/test";
import { extractHtmlToMarkdown } from "../src/extract";

describe("HTML extraction", () => {
  it("normalizes IDs that Defuddle cannot safely use in generated selectors", async () => {
    const schemaText = Array.from({ length: 100 }, (_, index) => `word${index}`).join(" ");
    const html = `<html><head><title>Fixture</title><script type="application/ld+json">${JSON.stringify(
      { "@type": "Article", articleBody: schemaText },
    )}</script></head><body><main><article><h1>Fixture</h1><p>This is the short primary article content with enough words to select the <a href="#P:1">main element</a>.</p></article></main><footer id="P:1"><p>${schemaText}</p></footer></body></html>`;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const result = await extractHtmlToMarkdown(html, new URL("https://example.com/article"));

      expect(result.extractor).toBe("defuddle");
      expect(result.markdown).toContain("word99");
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});
