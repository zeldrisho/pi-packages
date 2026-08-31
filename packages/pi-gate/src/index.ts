/**
 * pi-gate Extension
 *
 * Intercepts the built-in `bash` tool and gates each command against a
 * user-provided JSON configuration. Without a configuration file, every
 * command is allowed and the extension posts a warning on `session_start`
 * reminding the user to create one.
 *
 * Configuration file: `~/.pi/agent/pi-gate.json`
 *
 * The configuration has a single section, `operations`, which maps a
 * substring pattern to one of three actions:
 *
 * - `prompt` - ask the user to allow or deny the command
 * - `block`  - deny the command without asking
 * - `allow`  - explicitly allow (use to carve out an exception)
 *
 * When multiple patterns match a command, the longest pattern wins, so a
 * narrow `allow` rule can override a broader `prompt` or `block` rule.
 *
 * On first run, an example configuration is written next to the real one
 * at `~/.pi/agent/pi-gate.json.example` to document the format.
 *
 * Non-UI modes (print, JSON) never auto-approve. A `prompt` or `block` rule
 * in non-UI mode always blocks the command.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type Action = "prompt" | "block" | "allow";

export interface GateConfig {
  operations: Record<string, Action>;
}

export interface RuleMatch {
  pattern: string;
  action: Action;
}

const CONFIG_FILE_NAME = "pi-gate.json";
const EXAMPLE_FILE_NAME = "pi-gate.json.example";
const ACTIONS: readonly Action[] = ["prompt", "block", "allow"] as const;

const EXAMPLE_CONFIG: GateConfig = {
  operations: {
    "rm -rf": "prompt",
    sudo: "prompt",
    "chmod 777": "block",
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
 * Returns the full path to the example pi-gate configuration file.
 *
 * @returns The absolute path to pi-gate.json.example
 */
function examplePath(): string {
  return join(agentDir(), EXAMPLE_FILE_NAME);
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
    return { operations: rules };
  }
  if (!isJsonObject(parsed)) {
    return { operations: rules };
  }
  const operations = parsed["operations"];
  if (!isJsonObject(operations)) {
    return { operations: rules };
  }
  for (const [pattern, action] of Object.entries(operations)) {
    if (isAction(action)) {
      rules[pattern] = action;
    }
  }
  return { operations: rules };
}

/**
 * Loads the configuration from disk. Returns an empty configuration when the
 * file is missing; returns the parsed configuration otherwise.
 */
export function loadConfig(): GateConfig {
  const path = configPath();
  if (!existsSync(path)) {
    return { operations: {} };
  }
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return { operations: {} };
  }
  return parseConfig(content);
}

/**
 * Writes the example configuration next to the real one. Existing example
 * files are left alone so the user can rely on them to track the latest
 * supported shape.
 */
export function ensureExampleConfig(): void {
  const path = examplePath();
  if (existsSync(path)) return;
  try {
    mkdirSync(agentDir(), { recursive: true });
  } catch {
    return;
  }
  const example = JSON.stringify(EXAMPLE_CONFIG, null, 2) + "\n";
  try {
    writeFileSync(path, example, "utf-8");
  } catch {
    // Best-effort: the warning banner still surfaces the missing config.
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

function formatRule(match: RuleMatch): string {
  return `${JSON.stringify(match.pattern)}: ${JSON.stringify(match.action)}`;
}

/** Gate the built-in `bash` tool against the user-provided rules. */
export default function piGate(pi: ExtensionAPI): void {
  ensureExampleConfig();
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
        `pi-gate: no configuration found at ${path}; all commands are allowed. Copy ${examplePath()} to ${path} to start gating.`,
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
      return { block: true, reason };
    }

    // action === "prompt"
    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `pi-gate: command blocked because rule ${rule} requires a prompt, but no UI is available`,
      };
    }
    const choice = await ctx.ui.select(
      `pi-gate: allow this command?\n\n  ${command}\n\nMatched rule: ${rule}`,
      ["Allow", "Deny"],
    );
    if (choice !== "Allow") {
      return { block: true, reason: `pi-gate: command denied by user after matching rule ${rule}` };
    }
    return undefined;
  });
}
