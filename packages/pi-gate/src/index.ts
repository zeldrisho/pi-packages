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

import { existsSync } from "node:fs";
import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { configPath, ensureConfig, loadConfig } from "./config";
import { resolveRule } from "./rules";
import { formatPromptCommand, formatRule } from "./display";

const HERDR_BLOCKED_LABEL = "pi-gate: approval required";

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
  parseConfig,
} from "./config";
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
    reportHerdrBlocked(pi, ctx, true);
    let choice: string | undefined;
    try {
      choice = await ctx.ui.select(
        `pi-gate: allow this command?\n\n${formatPromptCommand(command, match.pattern)}\n\nMatched rule: ${rule}\nMatched command text is wrapped in »…«`,
        ["Allow", "Deny"],
        { timeout: config.promptTimeoutMs },
      );
    } finally {
      reportHerdrBlocked(pi, ctx, false);
    }
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
