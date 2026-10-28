import { keyHint, rawKeyHint } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
  Key,
  matchesKey,
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

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
  deadline?: number,
): Component {
  let selectedIndex = 0;
  let horizontalOffset = 0;
  let maxHorizontalOffset = 0;
  let pageWidth = 1;

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

      const longestLine = Math.max(
        0,
        ...command.split("\n").map((line) => visibleWidth(line.replace(/[»«]/gu, ""))),
      );

      pageWidth = longestLine > available ? Math.max(1, available - 2) : available;
      maxHorizontalOffset = longestLine > available ? longestLine - pageWidth : 0;
      horizontalOffset = Math.min(horizontalOffset, maxHorizontalOffset);
      const border = theme.style("─".repeat(available + 4), { fg: "border" });

      const lines = [
        border,
        panelLine(
          theme.bold(
            `${deadline === undefined ? "" : `(${Math.max(0, Math.ceil((deadline - Date.now()) / 1_000))}s) `}pi-gate: allow this command?`,
          ),
          width,
          "accent",
        ),
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
          const content = sliceByColumn(rendered, horizontalOffset, pageWidth, true);
          const prefix = horizontalOffset > 0 && visibleWidth(visible) > 0 ? "…" : "";
          const suffix = visibleWidth(visible) > horizontalOffset + pageWidth ? "…" : "";

          const padding = " ".repeat(
            Math.max(0, contentWidth - visibleWidth(prefix + content + suffix)),
          );

          return `  ${theme.style(prefix, { fg: "toolOutput" })}${content}${theme.style(suffix + padding, { fg: "toolOutput" })}  `;
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
        ...wrapTextWithAnsi(
          `${rawKeyHint("↑↓", "navigate")}  ${maxHorizontalOffset > 0 ? `${rawKeyHint("←→", "scroll command")}  ` : ""}${keyHint("tui.select.confirm", "select")}  ${keyHint("tui.select.cancel", "cancel")}`,
          available,
        ).map((line) => `  ${line}  `),
        border,
      ];

      return lines.map((line) => truncateToWidth(line, width));
    },
    handleInput(data: string): void {
      if (matchesKey(data, Key.left)) {
        horizontalOffset = Math.max(0, horizontalOffset - pageWidth);
      } else if (matchesKey(data, Key.right)) {
        horizontalOffset = Math.min(maxHorizontalOffset, horizontalOffset + pageWidth);
      } else if (keybindings.matches(data, "tui.select.up") || data === "k") {
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
