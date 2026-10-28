import type {
  ApprovalPromptKeybindings,
  ApprovalPromptTheme,
  ApprovalPromptTui,
} from "../src/approval-prompt";
import { describe, expect, it, vi } from "vite-plus/test";
import { createApprovalPrompt } from "../src/approval-prompt";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  keyHint: (key: string, label: string) => `${key} ${label}`,
  rawKeyHint: (key: string, label: string) => `${key} ${label}`,
}));

describe("approval prompt", () => {
  it("uses Pi semantic colors and presents command and matched-rule details", () => {
    const styled: Array<{ text: string; fg?: string; bg?: string }> = [];

    const theme: ApprovalPromptTheme = {
      style(text: string, style: { fg?: string; bg?: string }) {
        styled.push({ text, fg: style.fg, bg: style.bg });

        return text;
      },
      bold: (text: string) => text,
    };

    const keybindings: ApprovalPromptKeybindings = { matches: () => false };
    const tui: ApprovalPromptTui = { requestRender: vi.fn() };
    const done = vi.fn();

    const component = createApprovalPrompt(
      tui,
      theme,
      keybindings,
      done,
      "  sudo »rm« -rf /tmp/example",
      '"sudo": "prompt"',
    );

    const output = component.render(84).join("\n");

    expect(output).toContain("pi-gate: allow this command?");
    expect(output).toContain("sudo rm -rf /tmp/example");
    expect(output).not.toContain("»");
    expect(styled).toContainEqual(expect.objectContaining({ text: "rm", fg: "accent" }));
    expect(output).toContain('Matched rule: "sudo": "prompt"');
    expect(output).toContain("tui.select.confirm select");
    expect(output).not.toContain("scroll command");
    expect(styled).toContainEqual(expect.objectContaining({ fg: "accent" }));
  });

  it("indicates clipped command lines and the remaining timeout", () => {
    const theme: ApprovalPromptTheme = { style: (text) => text, bold: (text) => text };

    const component = createApprovalPrompt(
      { requestRender: vi.fn() },
      theme,
      { matches: () => false },
      vi.fn(),
      `${"x".repeat(90)}END`,
      "rule",
      Date.now() + 10_000,
    );

    const output = component.render(40).join("\n");

    expect(output).toContain("(10s)");
    expect(component.render(32).join("\n")).toContain("(10s)");
    expect(output).toContain("←→ scroll command");
    expect(output.indexOf("←→ scroll command")).toBeGreaterThan(output.indexOf("Deny"));
    expect(output).toContain("tui.select.cancel");
    expect(output).toContain("…");
    expect(output).not.toContain("END");
    component.handleInput?.("\x1b[C");
    const middle = component.render(40).join("\n");

    expect(middle).toMatch(/…x+…/);
    component.handleInput?.("\x1b[C");
    const end = component.render(40).join("\n");

    expect(end).toMatch(/…x+END/);
    expect(end).not.toContain("END…");
    component.handleInput?.("\x1b[D");
    expect(component.render(40).join("\n")).toMatch(/…x+…/);
  });

  it("moves the selected action and resolves only on confirmation", () => {
    const done = vi.fn();
    let renderRequested = 0;

    const theme: ApprovalPromptTheme = {
      style: (text: string) => text,
      bold: (text: string) => text,
    };

    const keybindings: ApprovalPromptKeybindings = {
      matches: (input, action) =>
        (input === "DOWN" && action === "tui.select.down") ||
        (input === "ENTER" && action === "tui.select.confirm"),
    };

    const tui: ApprovalPromptTui = { requestRender: () => (renderRequested += 1) };
    const component = createApprovalPrompt(tui, theme, keybindings, done, "command", "rule");

    component.handleInput?.("DOWN");
    expect(done).not.toHaveBeenCalled();
    expect(renderRequested).toBe(1);
    component.handleInput?.("ENTER");
    expect(done).toHaveBeenCalledWith("Deny");
  });
});
