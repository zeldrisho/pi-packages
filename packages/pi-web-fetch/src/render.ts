import { getMarkdownTheme, keyHint } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";

const COLLAPSED_LINES = 10;

/** Render document content separately from Pi-style interface notices. */
export function renderCollapsibleOutput(
  output: string,
  expanded: boolean,
  theme: { fg(color: "toolOutput" | "muted" | "warning", text: string): string },
  isError = false,
  warning?: string,
): Container {
  const lines = output.replace(/\r\n/g, "\n").split("\n");

  while (lines.at(-1) === "") lines.pop();
  const visible = expanded ? lines : lines.slice(0, COLLAPSED_LINES);
  const remaining = lines.length - visible.length;
  const component = new Container();
  const body = `\n${visible.join("\n")}`;

  component.addChild(
    isError
      ? new Text(theme.fg("toolOutput", body), 0, 0)
      : new Markdown(body, 0, 0, getMarkdownTheme(), {
          color: (text) => theme.fg("toolOutput", text),
        }),
  );

  if (remaining > 0) {
    component.addChild(
      new Text(
        `${theme.fg("muted", `... (${remaining} more lines, ${lines.length} total,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`,
        0,
        0,
      ),
    );
  }

  if (warning && !visible.includes(warning)) {
    component.addChild(new Spacer(1));
    component.addChild(new Text(theme.fg("warning", warning), 0, 0));
  }

  return component;
}
