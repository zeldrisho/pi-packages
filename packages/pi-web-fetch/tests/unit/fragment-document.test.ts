import { describe, expect, it } from "vite-plus/test";
import { extractHtmlToMarkdown, htmlToMarkdownFallback } from "../../src/extract";

// Real pages (for example packages.fedoraproject.org) emit valid HTML5 that omits
// <html>, <head>, and <body>. linkedom parses that as a fragment, so extraction must
// reattach the nodes before body-based extraction can see them.
const fragment = [
  "<!DOCTYPE html>",
  "<title>ripgrep - Fedora Packages</title>",
  '<link rel="stylesheet" href="/assets/main.css">',
  '<meta name="description" content="View ripgrep in the Fedora package repositories.">',
  "<h1>ripgrep</h1>",
  "<p>Line-oriented search tool.</p>",
  "<h3>Releases Overview</h3>",
  "<table><tr><td>Fedora 44</td><td>15.2.0-1.fc44</td></tr></table>",
].join("\n");

describe("tag-omitted HTML5 documents", () => {
  it("extracts content and title when html/head/body tags are omitted", async () => {
    const result = await extractHtmlToMarkdown(
      fragment,
      new URL("https://example.test/pkgs/rust-ripgrep/ripgrep/"),
    );

    expect(result.title).toBe("ripgrep - Fedora Packages");
    expect(result.markdown).toContain("Line-oriented search tool.");
    expect(result.markdown).toContain("Releases Overview");
    expect(result.markdown).toContain("15.2.0-1.fc44");
  });

  it("extracts plain text via the fallback when tags are omitted", () => {
    expect(htmlToMarkdownFallback(fragment)).toContain("Line-oriented search tool.");
    expect(htmlToMarkdownFallback(fragment)).toContain("Releases Overview");
  });

  it("still extracts a well-formed document", async () => {
    const result = await extractHtmlToMarkdown(
      "<html><head><title>Full</title></head><body><h1>Heading</h1><p>Body text.</p></body></html>",
      new URL("https://example.test/"),
    );

    expect(result.title).toBe("Full");
    expect(result.markdown).toContain("Body text.");
  });
});
