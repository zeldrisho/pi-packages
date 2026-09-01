import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vite-plus/test";
import { diagnoseExtraction } from "../src/evidence";
import { extractHtmlToMarkdown } from "../src/extract";

const substantial =
  "Readable issue context with reproduction details and expected behavior. ".repeat(12);

describe("extraction regressions", () => {
  it("preserves HTML tables as GFM tables", async () => {
    const html = `<html><body><main><article><h1>Compatibility</h1><table><thead><tr><th>Runtime</th><th>Supported</th></tr></thead><tbody><tr><td>Node 24</td><td>Yes</td></tr><tr><td>Node 22</td><td>No</td></tr></tbody></table><p>${substantial}</p></article></main></body></html>`;
    const result = await extractHtmlToMarkdown(html, new URL("https://example.com/table"));
    expect(result.markdown).toMatch(/\|\s*Runtime\s*\|\s*Supported\s*\|/);
    expect(result.markdown).toContain("Node 24");
  });

  it("recovers readable issue content from malformed markup", async () => {
    const html = `<html><head><title>Issue 42</title></head><body><main><article><h1>Parser fails on redirects<h2>Reproduction</h2><p>${substantial}<div><code>web_fetch(url)</code><p>Observed HTTP 503</article></main>`;
    const result = await extractHtmlToMarkdown(html, new URL("https://github.com/o/r/issues/42"));
    expect(result.markdown).toContain("Parser fails on redirects");
    expect(result.markdown).toContain("Observed HTTP 503");
    expect(result.markdown).toContain("web_fetch(url)");
  });

  it("extracts the saved real-world GitHub issue fixture", async () => {
    // Reduced from https://github.com/zeldrisho/pi-packages/issues/37.
    const html = await readFile(
      new URL("./fixtures/github-issue-37.html", import.meta.url),
      "utf8",
    );
    const result = await extractHtmlToMarkdown(
      html,
      new URL("https://github.com/zeldrisho/pi-packages/issues/37"),
    );
    expect(result.markdown).toContain("Repo-level overrides fork upstream dependency decisions");
    expect(result.markdown).toContain("Removal condition");
    expect(result.markdown).toContain("Lifecycle rules");
  });

  it("does not flag a content-rich app shell as sparse", async () => {
    const prose = "Application documentation remains available in server-rendered HTML. ".repeat(
      180,
    );
    const html = `<html><body><div id="app"><main><article><h1>Documentation</h1><p>${prose}</p></article></main></div><script>${"x".repeat(80_000)}</script></body></html>`;
    const result = await extractHtmlToMarkdown(html, new URL("https://example.com/app"));
    const diagnostics = diagnoseExtraction(html, result.markdown);
    expect(result.markdown).toContain("Application documentation");
    expect(diagnostics.sparseExtraction).toBe(false);
    expect(diagnostics.javascriptRequired).toBe(false);
  });
});
