import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vite-plus/test";
import { renderCollapsibleOutput } from "../src/render";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();

  return { ...actual, keyHint: () => "Alt+E to expand" };
});

describe("web output notices", () => {
  initTheme();
  it("keeps notices outside an unfinished Markdown code fence", () => {
    const styled: string[] = [];

    const theme = {
      fg(color: "toolOutput" | "muted" | "warning", text: string) {
        styled.push(color);

        return text;
      },
    };

    const output = ["```", ...Array.from({ length: 12 }, (_, i) => `line ${i}`)].join("\n");

    const rendered = renderCollapsibleOutput(output, false, theme, false, "[Continue]")
      .render(80)
      .join("\n");

    expect(rendered).toContain("3 more lines, 13 total, Alt+E to expand");
    expect(rendered).toContain("[Continue]");
    expect(stripTerminalSequences(rendered)).toMatch(/``` *\n\.\.\. \(3 more lines/);
    expect(rendered).toMatch(/Alt\+E to expand\) *\n\n\[Continue\]/);
    expect(styled).toContain("muted");
    expect(styled).toContain("warning");
    expect(
      renderCollapsibleOutput(output, true, theme, false, "[Continue]").render(80).join("\n"),
    ).not.toContain("[Continue]");
  });

  it("renders errors as literal text rather than Markdown", () => {
    const theme = { fg: (_color: "toolOutput" | "muted" | "warning", text: string) => text };

    const rendered = renderCollapsibleOutput("**failure**", true, theme, true)
      .render(80)
      .join("\n");

    expect(rendered).toContain("**failure**");
  });
});
