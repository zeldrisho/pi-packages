import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const ACTIONS = ["Allow", "Deny"] as const;

type Action = (typeof ACTIONS)[number];

type Foreground = "text" | "muted" | "accent" | "toolOutput" | "border";

export interface ApprovalPromptTheme {
  style(text: string, options: { fg?: Foreground; bold?: boolean }): string;
  bold(text: string): string;
}

export interface ApprovalPromptKeybindings {
  matches(
    data: string,
    action: "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel",
  ): boolean;
}

export interface ApprovalPromptTui {
  requestRender(): void;
}

/** Theme-aware approval dialog used by the interactive TUI. */
export function createApprovalPrompt(
  tui: ApprovalPromptTui,
  theme: ApprovalPromptTheme,
  keybindings: ApprovalPromptKeybindings,
  done: (result: Action | undefined) => void,
  command: string,
  rule: string,
): Component {
  let selectedIndex = 0;

  const invalidate = () => {};

  const innerWidth = (width: number) => Math.max(1, width - 4);

  const panelLine = (
    text: string,
    width: number,
    color: "text" | "muted" | "accent" | "toolOutput" = "text",
  ) => {
    const contentWidth = innerWidth(width);
    const content = truncateToWidth(text, contentWidth, "…");
    const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(content)));

    const styled = theme.style(`${content}${padding}`, { fg: color });

    return `  ${styled}  `;
  };

  const component: Component = {
    render(width: number): string[] {
      const available = innerWidth(width);
      const border = theme.style("─".repeat(available + 4), { fg: "border" });

      const lines = [
        border,
        panelLine(theme.bold("pi-gate: allow this command?"), width, "accent"),
        panelLine("Review the requested command or file change:", width, "muted"),
        panelLine("", width),
        ...command.split("\n").map((line) => {
          const contentWidth = innerWidth(width);
          const parts = line.split(/([»«])/u);
          let matched = false;

          const rendered = parts
            .map((part) => {
              if (part === "»") {
                matched = true;

                return "";
              }

              if (part === "«") {
                matched = false;

                return "";
              }

              return theme.style(part, { fg: matched ? "accent" : "toolOutput", bold: matched });
            })
            .join("");

          const visible = line.replace(/[»«]/gu, "");
          const content = truncateToWidth(visible, contentWidth, "…");
          const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(content)));

          return `  ${rendered}${theme.style(padding, { fg: "toolOutput" })}  `;
        }),
        panelLine("", width),
        panelLine(`Matched rule: ${rule}`, width, "muted"),
        panelLine("", width),
        ...ACTIONS.map((action, index) => {
          const selected = index === selectedIndex;
          const label = `${selected ? "→ " : "  "}${action}`;
          const row = truncateToWidth(label, available);
          const padded = `${row}${" ".repeat(Math.max(0, available - visibleWidth(row)))}`;

          return theme.style(`  ${padded}  `, {
            fg: selected ? "accent" : "text",
          });
        }),
        panelLine("", width),
        panelLine("↑↓ move · enter confirm · esc cancel", width, "muted"),
        border,
      ];

      return lines.map((line) => truncateToWidth(line, width));
    },
    handleInput(data: string): void {
      if (keybindings.matches(data, "tui.select.up") || data === "k") {
        selectedIndex = Math.max(0, selectedIndex - 1);
      } else if (keybindings.matches(data, "tui.select.down") || data === "j") {
        selectedIndex = Math.min(ACTIONS.length - 1, selectedIndex + 1);
      } else if (keybindings.matches(data, "tui.select.confirm")) {
        done(ACTIONS[selectedIndex]);

        return;
      } else if (keybindings.matches(data, "tui.select.cancel")) {
        done(undefined);

        return;
      } else {
        return;
      }

      component.invalidate();
      tui.requestRender();
    },
    invalidate,
  };

  return component;
}

export type ApprovalAction = Action;
