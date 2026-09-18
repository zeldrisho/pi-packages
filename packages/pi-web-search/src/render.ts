import { keyHint } from "@earendil-works/pi-coding-agent";

const COLLAPSED_LINES = 10;

interface RenderTheme {
  fg(color: "muted" | "toolOutput", text: string): string;
}

/** Format tool output using Pi's built-in collapsed-preview convention. */
export function formatCollapsibleOutput(
  output: string,
  expanded: boolean,
  theme: RenderTheme,
): string {
  const lines = output.replace(/\r\n/g, "\n").split("\n");

  while (lines.at(-1) === "") lines.pop();
  const totalLines = lines.length;
  const visibleLines = expanded ? lines : lines.slice(0, COLLAPSED_LINES);
  let text = visibleLines.map((line) => theme.fg("toolOutput", line)).join("\n");

  const remaining = totalLines - visibleLines.length;

  if (remaining > 0) {
    text += `${theme.fg("muted", `\n... (${remaining} more lines, ${totalLines} total,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
  }

  return `\n${text}`;
}
