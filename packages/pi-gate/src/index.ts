/**
 * pi-gate Extension
 *
 * Intercepts the built-in `bash` tool and gates each command against a
 * user-provided JSON configuration. Without a configuration file, the
 * extension creates one with starter rules and a default prompt timeout.
 *
 * Configuration file: `~/.pi/agent/pi-gate.json`
 *
 * The configuration has an `operations` section, which maps a substring
 * pattern to one of three actions, and an optional `promptTimeoutMs` setting:
 *
 * - `prompt` - ask the user to allow or deny the command
 * - `block`  - deny the command without asking
 * - `allow`  - explicitly allow (use to carve out an exception)
 *
 * When multiple patterns match a command, the longest pattern wins, so a
 * narrow `allow` rule can override a broader `prompt` or `block` rule.
 *
 * On first run, a configuration with the default prompt timeout and starter
 * operation rules is written to `~/.pi/agent/pi-gate.json`.
 *
 * Non-UI modes (print, JSON) never auto-approve. A `prompt` or `block` rule
 * in non-UI mode always blocks and requests termination of the agent turn.
 * Interactive prompts auto-deny after `promptTimeoutMs` rather than waiting
 * indefinitely.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type Action = "prompt" | "block" | "allow";

export interface GateConfig {
  operations: Record<string, Action>;
  promptTimeoutMs: number;
}

export interface RuleMatch {
  pattern: string;
  action: Action;
}

const CONFIG_FILE_NAME = "pi-gate.json";
export const CONFIG_SCHEMA_URL =
  "https://raw.githubusercontent.com/zeldrisho/pi-packages/main/packages/pi-gate/config.schema.json";
const ACTIONS: readonly Action[] = ["prompt", "block", "allow"] as const;
export const DEFAULT_PROMPT_TIMEOUT_MS = 30_000;
export const MAX_RULE_COUNT = 1_000;
export const MAX_RULE_PATTERN_LENGTH = 1_024;
export const MAX_DISPLAY_COMMAND_CHARACTERS = 2_000;
export const MAX_DISPLAY_COMMAND_LINES = 20;
export const MAX_PROMPT_TIMEOUT_MS = 86_400_000;
const DISPLAY_TRUNCATION_MARKER = "\n  … [command display truncated]";
const BIDI_CONTROL_CODE_POINTS = new Set([
  0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
]);

const DEFAULT_CONFIG: GateConfig = {
  promptTimeoutMs: DEFAULT_PROMPT_TIMEOUT_MS,
  operations: {
    "rm -rf": "prompt",
    sudo: "prompt",
    "sudo apt update": "allow",
    "chmod 777": "block",
    "corepack enable": "block",
  },
};

/**
 * Returns the directory where pi-gate configuration files are stored.
 *
 * @returns The absolute path to the agent configuration directory
 */
function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

/**
 * Returns the full path to the pi-gate configuration file.
 *
 * @returns The absolute path to pi-gate.json
 */
function configPath(): string {
  return join(agentDir(), CONFIG_FILE_NAME);
}

/**
 * Type guard that checks if an unknown value is a valid Action.
 *
 * @param value - The value to check
 * @returns `true` if the value is one of "prompt", "block", or "allow"
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- type-guard helper intentionally narrows untrusted JSON values at the parse boundary
function isAction(value: unknown): value is Action {
  return (
    typeof value === "string" &&
    // SAFETY: ACTIONS is the source-of-truth tuple of supported action strings; widening
    // it to readonly string[] lets Array.prototype.includes perform a runtime check
    // before the type predicate narrows the value to Action.
    (ACTIONS as readonly string[]).includes(value)
  );
}

/**
 * Type guard that checks if an unknown value is a plain JSON object.
 *
 * @param value - The value to check
 * @returns `true` if the value is a non-null object and not an array
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- type-guard helper intentionally narrows untrusted JSON values at the parse boundary
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses the user configuration file. Returns an empty configuration (no
 * rules) when the file is missing, unreadable, malformed, or fails
 * validation; an explicit empty `operations` object is also valid.
 *
 * Invalid entries are skipped so a single bad rule does not disable the
 * entire gate; parsing continues for the remaining rules.
 */
export function parseConfig(content: string): GateConfig {
  const rules: Record<string, Action> = {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { operations: rules, promptTimeoutMs: DEFAULT_PROMPT_TIMEOUT_MS };
  }
  if (!isJsonObject(parsed)) {
    return { operations: rules, promptTimeoutMs: DEFAULT_PROMPT_TIMEOUT_MS };
  }
  const configuredTimeout = parsed["promptTimeoutMs"];
  const promptTimeoutMs =
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validate the optional numeric field at the untrusted JSON boundary before applying range checks
    typeof configuredTimeout === "number" &&
    Number.isInteger(configuredTimeout) &&
    configuredTimeout > 0 &&
    configuredTimeout <= MAX_PROMPT_TIMEOUT_MS
      ? configuredTimeout
      : DEFAULT_PROMPT_TIMEOUT_MS;
  const operations = parsed["operations"];
  if (!isJsonObject(operations)) {
    return { operations: rules, promptTimeoutMs };
  }
  for (const [pattern, action] of Object.entries(operations)) {
    if (Object.keys(rules).length >= MAX_RULE_COUNT) break;
    if (pattern.length === 0 || pattern.length > MAX_RULE_PATTERN_LENGTH) continue;
    if (isAction(action)) {
      rules[pattern] = action;
    }
  }
  return { operations: rules, promptTimeoutMs };
}

/**
 * Loads the configuration from disk. Returns an empty configuration when the
 * file is missing; returns the parsed configuration otherwise.
 */
export function loadConfig(): GateConfig {
  const path = configPath();
  if (!existsSync(path)) {
    return { operations: {}, promptTimeoutMs: DEFAULT_PROMPT_TIMEOUT_MS };
  }
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return { operations: {}, promptTimeoutMs: DEFAULT_PROMPT_TIMEOUT_MS };
  }
  return parseConfig(content);
}

/**
 * Writes the default configuration on first run. Existing configuration files
 * are never overwritten.
 */
export function ensureConfig(): void {
  const path = configPath();
  if (existsSync(path)) return;
  try {
    mkdirSync(agentDir(), { recursive: true });
  } catch {
    return;
  }
  const content = JSON.stringify({ $schema: CONFIG_SCHEMA_URL, ...DEFAULT_CONFIG }, null, 2) + "\n";
  try {
    writeFileSync(path, content, { encoding: "utf-8", flag: "wx", mode: 0o600 });
  } catch {
    // Best-effort: another process may have created it, or the warning banner
    // will surface that no configuration is active.
  }
}

/**
 * Resolves the rule that applies to a command against the configured rules.
 *
 * Returns `null` when no rule matches, in which case the caller should let the
 * command through. When multiple rules match, the longest pattern wins so
 * that narrow rules can override broader ones.
 *
 * @param command - The bash command to evaluate against the rules
 * @param rules - A map of pattern strings to actions
 * @returns The matched pattern and action, or `null` if no rule matches
 */
export function resolveRule(command: string, rules: Record<string, Action>): RuleMatch | null {
  let bestPattern: string | null = null;
  for (const pattern of Object.keys(rules)) {
    if (!command.includes(pattern)) continue;
    if (bestPattern === null || pattern.length > bestPattern.length) {
      bestPattern = pattern;
    }
  }
  if (bestPattern === null) return null;
  return { pattern: bestPattern, action: rules[bestPattern] };
}

/** Returns only the action selected by {@link resolveRule}. */
export function resolveAction(command: string, rules: Record<string, Action>): Action | null {
  return resolveRule(command, rules)?.action ?? null;
}

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
function formatPromptCommand(command: string, pattern: string): string {
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
function formatRule(match: RuleMatch): string {
  return formatCommandForDisplay(
    `${JSON.stringify(match.pattern)}: ${JSON.stringify(match.action)}`,
  );
}

/** Gate the built-in `bash` tool against the user-provided rules. */
export default function piGate(pi: ExtensionAPI): void {
  ensureConfig();
  const config = loadConfig();

  pi.on("session_start", (_event, ctx) => {
    const path = configPath();
    const ruleCount = Object.keys(config.operations).length;
    if (existsSync(path)) {
      if (ruleCount === 0) {
        ctx.ui.notify(
          `pi-gate: ${path} is empty; no commands are gated. Add rules to the "operations" object to start gating.`,
          "warning",
        );
      } else {
        ctx.ui.notify(
          `pi-gate: ${ruleCount} operation rule${ruleCount === 1 ? "" : "s"} loaded from ${path}`,
          "info",
        );
      }
    } else {
      ctx.ui.notify(
        `pi-gate: could not create configuration at ${path}; all commands are allowed until that file is created.`,
        "warning",
      );
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;
    if (!isToolCallEventType("bash", event)) return undefined;
    const command = event.input.command;
    const match = resolveRule(command, config.operations);
    if (match === null || match.action === "allow") return undefined;
    const rule = formatRule(match);

    if (match.action === "block") {
      const reason = `pi-gate: command blocked by rule ${rule}`;
      if (ctx.hasUI) {
        ctx.ui.notify(reason, "warning");
      }
      return { block: true, reason, terminate: true };
    }

    // action === "prompt"
    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `pi-gate: command blocked because rule ${rule} requires a prompt, but no UI is available`,
        terminate: true,
      };
    }
    const choice = await ctx.ui.select(
      `pi-gate: allow this command?\n\n${formatPromptCommand(command, match.pattern)}\n\nMatched rule: ${rule}\nMatched command text is wrapped in »…«`,
      ["Allow", "Deny"],
      { timeout: config.promptTimeoutMs },
    );
    if (choice !== "Allow") {
      return {
        block: true,
        reason: `pi-gate: command denied, dismissed, or timed out after matching rule ${rule}`,
        terminate: true,
      };
    }
    return undefined;
  });
}
