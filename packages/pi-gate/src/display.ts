import type { RuleMatch } from "./rules";

export const MAX_DISPLAY_COMMAND_CHARACTERS = 2_000;
export const MAX_DISPLAY_COMMAND_LINES = 20;
const DISPLAY_TRUNCATION_MARKER = "\n  … [command display truncated]";
const BIDI_CONTROL_CODE_POINTS = new Set([
  0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
]);

/** Converts terminal controls and bidirectional formatting characters to visible escapes. */
function escapeUnsafeDisplayCharacter(character: string): string {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) return "";
  if (
    codePoint < 0x20 ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    BIDI_CONTROL_CODE_POINTS.has(codePoint)
  ) {
    return `\\u{${codePoint.toString(16).padStart(4, "0")}}`;
  }
  return character;
}

interface MatchRange {
  start: number;
  end: number;
}

/** Finds non-overlapping raw match ranges before any display escaping occurs. */
function findMatchRanges(command: string, pattern?: string): MatchRange[] {
  if (!pattern) return [];
  const ranges: MatchRange[] = [];
  let offset = 0;
  while (offset <= command.length - pattern.length) {
    const start = command.indexOf(pattern, offset);
    if (start === -1) break;
    ranges.push({ start, end: start + pattern.length });
    offset = start + pattern.length;
  }
  return ranges;
}

/** Produces bounded terminal-safe text, optionally marking raw matched spans. */
function renderCommandForDisplay(command: string, pattern?: string): string {
  const ranges = findMatchRanges(command, pattern);
  let rangeIndex = 0;
  let activeRange: MatchRange | undefined;
  let output = "";
  let lineCount = 1;
  let offset = 0;

  const truncate = (closeActiveRange = activeRange !== undefined): string =>
    output + (closeActiveRange ? "«" : "") + DISPLAY_TRUNCATION_MARKER;

  while (offset < command.length) {
    const rawStart = offset;
    let rawEnd: number;
    let rendered: string;
    const codePoint = command.codePointAt(offset);
    if (codePoint === 0x0d) {
      rawEnd = offset + (command.codePointAt(offset + 1) === 0x0a ? 2 : 1);
      rendered = "\n";
    } else {
      const character = String.fromCodePoint(codePoint!);
      rawEnd = offset + character.length;
      rendered = character === "\n" ? character : escapeUnsafeDisplayCharacter(character);
    }

    const nextRange = ranges[rangeIndex];
    const wasInsideRange = activeRange !== undefined;
    const opensRange =
      activeRange === undefined &&
      nextRange !== undefined &&
      nextRange.start < rawEnd &&
      nextRange.end > rawStart;
    if (opensRange) activeRange = nextRange;
    const closesRange = activeRange !== undefined && activeRange.end <= rawEnd;
    const decorated = `${opensRange ? "»" : ""}${rendered}${closesRange ? "«" : ""}`;

    if (rendered === "\n") {
      if (lineCount >= MAX_DISPLAY_COMMAND_LINES) return truncate(wasInsideRange);
      lineCount += 1;
    }
    if (output.length + decorated.length > MAX_DISPLAY_COMMAND_CHARACTERS) {
      return truncate(wasInsideRange);
    }

    output += decorated;
    if (closesRange) {
      activeRange = undefined;
      rangeIndex += 1;
    }
    offset = rawEnd;
  }
  return output;
}

/**
 * Produces bounded terminal-safe text for a command without changing the command that is executed.
 */
export function formatCommandForDisplay(command: string): string {
  return renderCommandForDisplay(command);
}

/** Marks raw matched-rule occurrences while producing terminal-safe command text. */
export function highlightRuleForDisplay(command: string, pattern: string): string {
  return renderCommandForDisplay(command, pattern);
}

/** Indents every line of terminal-safe command text for the confirmation dialog. */
export function formatPromptCommand(command: string, pattern: string): string {
  return highlightRuleForDisplay(command, pattern)
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

/**
 * Formats a rule match as a terminal-safe, human-readable string.
 *
 * @param match - The rule match to format
 * @returns A string representation showing the pattern and action
 */
export function formatRule(match: RuleMatch): string {
  return formatCommandForDisplay(
    `${JSON.stringify(match.pattern)}: ${JSON.stringify(match.action)}`,
  );
}
