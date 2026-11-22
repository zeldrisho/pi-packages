import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vite-plus/test";
import { diagnoseExtraction } from "../src/document/evidence.ts";
import {
  extractHtmlToMarkdown,
  filterAndroidBomHtml,
  htmlToMarkdownFallback,
} from "../src/document/extract.ts";

const substantial =
  "Readable issue context with reproduction details and expected behavior. ".repeat(12);

describe("extraction regressions", () => {
  it("filters Android BOM rows by the origin's filter-value metadata", () => {
    const html =
      "<table><thead><tr><th>Library</th></tr></thead><tbody>" +
      '<tr filter-value="2026.08.00"><td>1.12.0</td></tr>' +
      '<tr filter-value="2026.06.01"><td>1.11.0</td></tr>' +
      "</tbody></table>";

    const filtered = filterAndroidBomHtml(html, "2026.08.00");

    expect(filtered).toContain("1.12.0");
    expect(filtered).not.toContain("1.11.0");
    expect(filterAndroidBomHtml(html, "2026.99.99")).toBeUndefined();
  });

  it("keeps fragment siblings and deduplicates equivalent tab mappings", async () => {
    const html = `<p>Shared preface.</p><main><div data-surface-filter-pills><div role="tablist"><button role="tab" data-surface-id="hub" aria-controls="hub">App</button><button role="tab" data-surface-id="cli" aria-controls="cli">CLI</button></div></div><div role="tabpanel" id="hub" data-surface-pane="hub">APPONLY</div><div role="tabpanel" id="cli" data-surface-pane="cli">CLIONLY</div></main>`;

    const result = await extractHtmlToMarkdown(
      html,
      new URL("https://example.com/install?tab=cli"),
    );

    expect(result.surfaceView?.markdown).toContain("CLIONLY");
    expect(result.surfaceView?.markdown).not.toContain("APPONLY");
  });

  it("derives an explicitly requested documentation surface without changing the complete page", async () => {
    const html = `<html><body><main><article><h1>Authenticate</h1><p>Shared introduction.</p><div data-surface-filter-pills><div role="tablist"><button role="tab" data-surface-id="hub">App</button><button role="tab" data-surface-id="cli">CLI</button></div></div><div data-surface-pane="hub"><h2>App setup</h2><p>APPONLY</p></div><div data-surface-pane="cli"><h2>CLI setup</h2><p>CLIONLY</p><div role="tabpanel"><p>Nested instructions</p></div></div></article></main></body></html>`;

    const result = await extractHtmlToMarkdown(
      html,
      new URL("https://example.com/install?tab=cli"),
    );

    expect(result.markdown).toContain("APPONLY");
    expect(result.markdown).toContain("CLIONLY");
    expect(result.surfaceView).toMatchObject({ selected: "cli", omitted: 1 });
    expect(result.surfaceView?.markdown).toContain("Shared introduction");
    expect(result.surfaceView?.markdown).toContain("CLIONLY");
    expect(result.surfaceView?.markdown).toContain("Nested instructions");
    expect(result.surfaceView?.markdown).not.toContain("APPONLY");

    for (const query of ["", "?tab=unknown", "?tab=cli&tab=hub"]) {
      expect(
        (await extractHtmlToMarkdown(html, new URL(`https://example.com/install${query}`)))
          .surfaceView,
      ).toBeUndefined();
    }

    const ambiguous = html.replace('data-surface-id="hub"', 'data-surface-id="cli"');
    expect(
      (await extractHtmlToMarkdown(ambiguous, new URL("https://example.com/install?tab=cli")))
        .surfaceView,
    ).toBeUndefined();
  });

  it("selects standard ARIA tabs only when their panel mapping is unambiguous", async () => {
    const html = `<html><body><main><h1>Guide</h1><p>Shared content</p><div role="tablist"><button role="tab" id="linux" aria-controls="linux-panel">Linux</button><button role="tab" id="windows" aria-controls="windows-panel">Windows</button></div><div><section role="tabpanel" id="linux-panel"><h2>Linux setup</h2><p>LINUXCONTENT</p></section><section role="tabpanel" id="windows-panel" hidden><h2>Windows setup</h2><p>WINDOWSCONTENT</p></section></div></main></body></html>`;
    const url = new URL("https://example.com/guide?tab=windows");
    const result = await extractHtmlToMarkdown(html, url);
    expect(result.surfaceView?.markdown).toContain("WINDOWSCONTENT");
    expect(result.surfaceView?.markdown).not.toContain("LINUXCONTENT");
    expect(result.surfaceView?.markdown).toContain("Shared content");
    const ambiguous = html.replace('id="linux"', 'id="windows"');
    expect((await extractHtmlToMarkdown(ambiguous, url)).surfaceView).toBeUndefined();
    const incomplete = html.replace('aria-controls="linux-panel"', 'data-other="linux-panel"');
    expect((await extractHtmlToMarkdown(incomplete, url)).surfaceView).toBeUndefined();
  });

  it("preserves HTML tables as GFM tables", async () => {
    const html = `<html><body><main><article><h1>Compatibility</h1><table><thead><tr><th>Runtime</th><th>Supported</th></tr></thead><tbody><tr><td>Node 24</td><td>Yes</td></tr><tr><td>Node 22</td><td>No</td></tr></tbody></table><p>${substantial}</p></article></main></body></html>`;
    const result = await extractHtmlToMarkdown(html, new URL("https://example.com/table"));
    expect(result.extractor).toBe("defuddle");
    expect(result.markdown).toMatch(/\|\s*Runtime\s*\|\s*Supported\s*\|/);
    expect(result.markdown).toContain("Node 24");
  });

  it("does not retain event handlers in complex table HTML", async () => {
    const html = `<html><body><main><article><h1>Compatibility</h1><p>${substantial}</p><table><tr><th colspan="2">Runtime</th></tr><tr><td onclick="alert(1)">Node</td><td>Supported</td></tr></table></article></main></body></html>`;
    const result = await extractHtmlToMarkdown(html, new URL("https://example.com/table"));
    expect(result.extractor).toBe("defuddle");
    expect(result.markdown).toContain("Supported");
    expect(result.markdown).not.toMatch(/onclick|alert\(1\)/i);
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

  it("extracts sparse server-rendered content without inventing text", async () => {
    const html = "<html><body><main><h1>Status</h1><p>Operational</p></main></body></html>";
    const result = await extractHtmlToMarkdown(html, new URL("https://example.com/status"));
    expect(result.markdown).toContain("Operational");
    expect(result.markdown.length).toBeLessThan(200);
  });

  it("preserves repeated documentation entries in source order", async () => {
    const html = `<html><body><main><article><h1>Commands</h1><p>${substantial}</p><section><h2>First command</h2><p>Run alpha for the initial result.</p></section><section><h2>Second command</h2><p>Run beta for the next result.</p></section></article></main></body></html>`;
    const result = await extractHtmlToMarkdown(html, new URL("https://example.com/commands"));
    expect(result.extractor).toBe("defuddle");
    expect(result.markdown).toContain("Run alpha");
    expect(result.markdown).toContain("Run beta");
    expect(result.markdown.indexOf("Run alpha")).toBeLessThan(result.markdown.indexOf("Run beta"));
  });

  it("removes script, template and comment content in both extraction paths", async () => {
    const html = `<html><body><main><article><h1>Guide</h1><p>${substantial}</p><!-- COMMENT_SENTINEL --><script>SCRIPT_SENTINEL</script><template>TEMPLATE_SENTINEL</template></article></main></body></html>`;
    const result = await extractHtmlToMarkdown(html, new URL("https://example.com/guide"));

    for (const output of [result.markdown, htmlToMarkdownFallback(html)]) {
      expect(output).toContain("Readable issue context");
      expect(output).not.toContain("COMMENT_SENTINEL");
      expect(output).not.toContain("SCRIPT_SENTINEL");
      expect(output).not.toContain("TEMPLATE_SENTINEL");
    }
  });

  it("omits explicitly hidden elements in primary and fallback extraction", async () => {
    const html = `<html><body><main><article><h1>Guide</h1><p>${substantial}</p><p hidden>HIDDEN_SENTINEL</p><p aria-hidden="true">ARIA_SENTINEL</p><p style="display:none">DISPLAY_SENTINEL</p></article></main></body></html>`;
    const result = await extractHtmlToMarkdown(html, new URL("https://example.com/hidden"));
    const fallback = htmlToMarkdownFallback(html);

    for (const sentinel of ["HIDDEN_SENTINEL", "ARIA_SENTINEL", "DISPLAY_SENTINEL"]) {
      expect(result.markdown).not.toContain(sentinel);
      expect(fallback).not.toContain(sentinel);
    }
  });

  it("retains visible content with unrelated accessibility and style attributes", () => {
    const html = `<main><p aria-hidden="false">VISIBLE_ARIA</p><p style="display: block; visibility: visible">VISIBLE_STYLE</p><p style="visibility: hidden !important">HIDDEN_STYLE</p></main>`;
    const output = htmlToMarkdownFallback(html);
    expect(output).toContain("VISIBLE_ARIA");
    expect(output).toContain("VISIBLE_STYLE");
    expect(output).not.toContain("HIDDEN_STYLE");
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
