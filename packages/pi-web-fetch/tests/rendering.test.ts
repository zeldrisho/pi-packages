import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vite-plus/test";
import { sliceCompleteDocument } from "../src/content";
import { htmlToMarkdownFallback } from "../src/extract";
import registerWebFetch from "../src/index";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...actual, keyHint: () => "Ctrl+O to expand" };
});

interface RenderedComponent {
  render(width: number): string[];
}

interface RenderTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

const renderTheme: RenderTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

describe("web_fetch rendering", () => {
  it("shows a Pi-style preview until tool output is expanded", () => {
    let registered: unknown;
    registerWebFetch({
      registerTool(tool: unknown) {
        registered = tool;
      },
    } as unknown as ExtensionAPI);

    const tool = registered as {
      renderCall(args: { url: string }, theme: RenderTheme): RenderedComponent;
      renderResult(
        result: {
          content: Array<{ type: "text"; text: string }>;
          details: {
            extractor: "defuddle";
            cached: boolean;
            truncated: boolean;
            characterCount: number;
          };
        },
        options: { expanded: boolean; isPartial: boolean },
        theme: RenderTheme,
      ): RenderedComponent;
    };
    const output = Array.from({ length: 12 }, (_, index) => `Fetched line ${index + 1}`).join("\n");
    const result = {
      content: [{ type: "text" as const, text: output }],
      details: {
        extractor: "defuddle" as const,
        cached: false,
        truncated: false,
        characterCount: output.length,
      },
    };

    const collapsed = tool
      .renderResult(result, { expanded: false, isPartial: false }, renderTheme)
      .render(200)
      .join("\n");
    const expanded = tool
      .renderResult(result, { expanded: true, isPartial: false }, renderTheme)
      .render(200)
      .join("\n");

    expect(collapsed).toContain("Fetched line 1");
    expect(collapsed).toContain("2 more lines, 12 total, Ctrl+O to expand");
    expect(collapsed).not.toContain("Fetched line 11");
    expect(expanded).toContain("Fetched line 12");
    expect(expanded).not.toContain("more lines");
    expect(
      tool.renderCall({ url: "https://example.com" }, renderTheme).render(200).join("\n"),
    ).toContain("web_fetch https://example.com");
    expect(
      tool
        .renderResult(result, { expanded: false, isPartial: true }, renderTheme)
        .render(200)
        .join("\n"),
    ).toContain("Fetching…");
    expect(
      tool
        .renderResult(
          { ...result, content: [] },
          { expanded: false, isPartial: false },
          renderTheme,
        )
        .render(200)
        .join("\n"),
    ).toContain("No content");
  });

  it("bounds multibyte content without splitting a surrogate pair", () => {
    const result = sliceCompleteDocument(
      {
        url: "https://example.com",
        contentType: "text/plain",
        markdown: "😀".repeat(100_000),
        extractor: "raw",
        shellSuspected: false,
      },
      0,
      200_000,
    );
    expect(result.truncated).toBe(true);
    expect(result.markdown).not.toMatch(/[\uD800-\uDBFF]\n\n\[Content truncated/);
  });

  it("provides a basic HTML fallback that removes non-content elements", () => {
    const markdown = htmlToMarkdownFallback(
      "<html><body>  Hello   world<nav>menu</nav><script>bad()</script><p>Next</p></body></html>",
    );
    expect(markdown).toContain("Hello world");
    expect(markdown).toContain("Next");
    expect(markdown).not.toContain("menu");
    expect(markdown).not.toContain("bad()");
  });
});
