/**
 * pi-gate Extension
 *
 * Intercepts the built-in `bash` tool and protects the gate configuration
 * from `write` and `edit` calls. Without a configuration file, the
 * extension creates one with starter rules and a default prompt timeout.
 *
 * Configuration file: `~/.pi/agent/gate.json` (legacy fallback: `pi-gate.json`)
 *
 * The configuration has an `operations` section, which maps a substring
 * pattern to one of three actions, and an optional `promptTimeoutMs` setting:
 *
 * - `prompt` - ask the user to allow or deny the command
 * - `block`  - deny the command without asking
 * - `allow`  - explicitly allow (use to carve out an exception)
 *
 * Matching is case-insensitive and whitespace-normalized. An allow occurrence
 * suppresses only restrictive occurrences fully contained within its span;
 * surviving blocks take priority over prompts.
 *
 * On first run, a configuration with the default prompt timeout and starter
 * operation rules is written to `~/.pi/agent/gate.json` when neither file exists.
 *
 * Non-UI modes (print, JSON) never auto-approve. A `prompt` or `block` rule
 * in non-UI mode always blocks and requests termination of the agent turn.
 * Interactive prompts auto-deny after `promptTimeoutMs` rather than waiting
 * indefinitely.
 */

import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { configPath, ensureConfig, loadConfigResult } from "./config";
import {
  bashTouchesConfig,
  CONFIG_CHANGE_REASON,
  isProtectedConfigPath,
} from "./config-protection";
import { resolveRule } from "./rules";
import { formatCommandForDisplay, formatPromptCommand, formatRule } from "./display";

const HERDR_BLOCKED_LABEL = "pi-gate: approval required";

const MAX_REASON_RULE_NAME_LENGTH = 27;

/** Escapes a rule pattern for terminal display and bounds its length in denial messages. */
function reasonRuleName(pattern: string): string {
  const safePattern = formatCommandForDisplay(pattern);

  return safePattern.length <= MAX_REASON_RULE_NAME_LENGTH
    ? safePattern
    : `${safePattern.slice(0, MAX_REASON_RULE_NAME_LENGTH - 1)}…`;
}

/** Formats an approval timeout with the matched rule, elapsed limit in seconds, and retry guidance. */
function timeoutReason(pattern: string, timeoutMs: number): string {
  return `pi-gate: no response to rule "${reasonRuleName(pattern)}" within ${timeoutMs / 1_000}s; command not run. Ask the user whether to retry.`;
}

function reportHerdrBlocked(pi: ExtensionAPI, ctx: { mode?: string }, active: boolean): void {
  if (
    ctx.mode !== "tui" ||
    process.env.HERDR_ENV !== "1" ||
    !process.env.HERDR_SOCKET_PATH ||
    !process.env.HERDR_PANE_ID
  ) {
    return;
  }

  // The Herdr integration consumes this event and reports it through its
  // existing socket connection. Keep this optional integration best-effort so
  // a missing or incompatible Herdr extension cannot affect command gating.
  try {
    pi.events.emit("herdr:blocked", {
      active,
      label: HERDR_BLOCKED_LABEL,
    });
  } catch {
    // Herdr is an optional host integration.
  }
}

export type { Action, GateConfig } from "./config";

export {
  CONFIG_SCHEMA_URL,
  DEFAULT_PROMPT_TIMEOUT_MS,
  MAX_PROMPT_TIMEOUT_MS,
  MAX_RULE_COUNT,
  MAX_RULE_PATTERN_LENGTH,
  ensureConfig,
  loadConfig,
  loadConfigResult,
  parseConfig,
} from "./config";

export type { ConfigLoadResult, ConfigLoadStatus } from "./config";

export type { RuleMatch } from "./rules";

export { resolveAction, resolveRule } from "./rules";

export {
  MAX_DISPLAY_COMMAND_CHARACTERS,
  MAX_DISPLAY_COMMAND_LINES,
  formatCommandForDisplay,
  highlightRuleForDisplay,
} from "./display";

/** Gate the built-in `bash` tool against the user-provided rules. */
export default function piGate(pi: ExtensionAPI): void {
  ensureConfig();
  let loadResult = loadConfigResult();
  const { config } = loadResult;

  pi.on("session_start", (_event, ctx) => {
    const path = configPath();
    const ruleCount = Object.keys(config.operations).length;

    if (loadResult.status === "loaded") {
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
    } else if (loadResult.status === "failed") {
      ctx.ui.notify(
        "pi-gate: configuration exists but could not be loaded; prompting for all commands until it is fixed.",
        "warning",
      );
    } else {
      ctx.ui.notify(
        `pi-gate: no configuration found at ${configPath()}; all commands are allowed until it is created.`,
        "warning",
      );
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    let command: string;
    let configChange = false;

    if (event.toolName === "bash") {
      if (!isToolCallEventType("bash", event)) return undefined;
      command = event.input.command;
      configChange = bashTouchesConfig(command);
    } else if (isToolCallEventType("write", event)) {
      if (!isProtectedConfigPath(event.input.path)) return undefined;
      command = event.input.path;
      configChange = true;
    } else if (isToolCallEventType("edit", event)) {
      if (!isProtectedConfigPath(event.input.path)) return undefined;
      command = event.input.path;
      configChange = true;
    } else {
      return undefined;
    }

    if (loadResult.status === "failed") loadResult = loadConfigResult();

    const match = configChange
      ? { pattern: "gate config change requires approval", action: "prompt" as const }
      : loadResult.status === "failed"
        ? { pattern: "configuration unavailable", action: "prompt" as const }
        : resolveRule(command, loadResult.config.operations);

    if (match === null || match.action === "allow") return undefined;
    const rule = configChange ? CONFIG_CHANGE_REASON : formatRule(match);

    if (match.action === "block") {
      const reason = `pi-gate: blocked by rule "${reasonRuleName(match.pattern)}". Do not retry or use equivalent commands; ask the user.`;

      if (ctx.hasUI) ctx.ui.notify(reason, "warning");

      return { block: true, reason, terminate: true };
    }

    if (!ctx.hasUI) {
      return {
        block: true,
        reason: configChange
          ? CONFIG_CHANGE_REASON
          : `pi-gate: rule "${reasonRuleName(match.pattern)}" needs approval but no UI is available. Do not retry; ask the user.`,
        terminate: true,
      };
    }

    reportHerdrBlocked(pi, ctx, true);
    let choice: string | undefined;
    let timedOut = false;
    const timeoutMs = loadResult.config.promptTimeoutMs;

    const promptCommand = configChange
      ? `  ${command}`
      : formatPromptCommand(command, match.pattern);

    try {
      const promptStartedAt = Date.now();
      choice = await ctx.ui.select(
        `pi-gate: allow this command?\n\n${promptCommand}\n\nMatched rule: ${rule}${configChange ? "" : "\nMatched command text is wrapped in »…«"}`,
        ["Allow", "Deny"],
        { timeout: timeoutMs },
      );
      // Pi returns undefined for both dismissal and timeout; elapsed time separates the timeout case.
      timedOut = choice === undefined && Date.now() - promptStartedAt >= timeoutMs;
    } finally {
      reportHerdrBlocked(pi, ctx, false);
    }

    if (choice !== "Allow") {
      return {
        block: true,
        reason: timedOut
          ? timeoutReason(match.pattern, timeoutMs)
          : configChange
            ? CONFIG_CHANGE_REASON
            : `pi-gate: denied by rule "${reasonRuleName(match.pattern)}". Do not retry or use equivalent commands; ask the user.`,
        terminate: true,
      };
    }

    return undefined;
  });
}
