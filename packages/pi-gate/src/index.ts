/**
 * pi-gate Extension
 *
 * Intercepts the built-in `bash` tool and protects the gate configuration
 * from `write` and `edit` calls. Without a configuration file, the
 * extension creates one with starter rules and a default prompt timeout.
 *
 * Configuration file: `~/.pi/agent/gate.json` (legacy fallback: `pi-gate.json`)
 *
 * The configuration has an `operations` section, which maps a command-text
 * pattern to one of three actions, and an optional `promptTimeoutMs` setting:
 *
 * - `prompt` - ask the user to allow or deny the command
 * - `block`  - deny the command without asking
 * - `allow`  - explicitly allow (use to carve out an exception)
 *
 * Simple commands match whole words without treating literal echo/printf data
 * as commands; uncertain syntax retains conservative substring matching.
 * Matching is case-insensitive and whitespace-normalized. Allow occurrences
 * suppress contained restrictions in the same command; surviving blocks win.
 *
 * On first session start, a configuration with the default prompt timeout and starter
 * operation rules is written to `~/.pi/agent/gate.json` when neither file exists.
 *
 * Non-UI modes (print, JSON) never auto-approve. A `prompt` or `block` rule
 * in non-UI mode always blocks and requests termination of the agent turn.
 * Interactive prompts auto-deny after `promptTimeoutMs` rather than waiting
 * indefinitely.
 */

import {
  isToolCallEventType,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { createApprovalPrompt, type ApprovalAction } from "./approval-prompt";
import { configPath, ensureConfig, loadConfigResult } from "./config";
import {
  bashTouchesConfig,
  CONFIG_CHANGE_REASON,
  isProtectedConfigPath,
} from "./config-protection";
import { resolveRule } from "./rules";
import { formatCommandForDisplay, formatPromptCommand, formatRule } from "./display";

const HERDR_BLOCKED_LABEL = "pi-gate: approval required";

/** Uses a themed terminal component in TUI mode and Pi's standard selector elsewhere. */
async function selectApproval(
  ctx: ExtensionContext,
  timeoutMs: number,
  signal: AbortSignal,
  command: string,
  rule: string,
  showMatchHint: boolean,
): Promise<string | undefined> {
  if (ctx.mode !== "tui" || !ctx.ui.custom) {
    return ctx.ui.select(
      `pi-gate: allow this command?\n\n${command}\n\nMatched rule: ${rule}${showMatchHint ? "\nMatched command text is wrapped in »…«" : ""}`,
      ["Allow", "Deny"],
      { timeout: timeoutMs, signal },
    );
  }

  let uiDone: ((value: ApprovalAction | undefined) => void) | undefined;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let countdown: ReturnType<typeof setInterval> | undefined;
  let removeAbortListener: (() => void) | undefined;

  return new Promise<ApprovalAction | undefined>((resolve, reject) => {
    const finish = (value: ApprovalAction | undefined) => {
      if (settled) return;
      settled = true;

      if (timer !== undefined) clearTimeout(timer);

      if (countdown !== undefined) clearInterval(countdown);
      removeAbortListener?.();
      resolve(value);
      uiDone?.(value);
    };

    const onAbort = () => finish(undefined);

    try {
      const deadline = Date.now() + timeoutMs;
      timer = setTimeout(() => finish(undefined), timeoutMs);

      const uiPromise = ctx.ui.custom<ApprovalAction | undefined>(
        (tui, theme, keybindings, done) => {
          uiDone = done;
          countdown = setInterval(() => tui.requestRender(), 1_000);

          return createApprovalPrompt(tui, theme, keybindings, done, command, rule, deadline);
        },
      );

      uiPromise
        .then(finish)
        .catch(reject)
        .finally(() => {
          if (timer !== undefined) clearTimeout(timer);

          if (countdown !== undefined) clearInterval(countdown);
          removeAbortListener?.();
        });

      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => signal.removeEventListener("abort", onAbort);

        if (signal.aborted) onAbort();
      }
    } catch (error) {
      settled = true;

      if (timer !== undefined) clearTimeout(timer);

      if (countdown !== undefined) clearInterval(countdown);
      removeAbortListener?.();
      reject(error);
    }
  });
}

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
  return `pi-gate: no response to rule "${reasonRuleName(pattern)}" within ${timeoutMs / 1_000}s; command not run. Ask the user whether to retry approval.`;
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

/**
 * Gates `bash` calls against user rules and requires approval for protected
 * configuration writes and edits. Attempts to create a starter configuration
 * at session start if absent.
 * Reloads rules before gating and after each prompt; approvals apply per call.
 * Dialogs are serialized. Cancellation, shutdown, and session replacement deny
 * active and queued gated calls; policy changes invalidate an active approval.
 * UI failures reject the affected tool call.
 */
export default function piGate(pi: ExtensionAPI): void {
  let loadResult = loadConfigResult();
  let session = new AbortController();
  let policy = JSON.stringify(loadResult);
  let revision = 0;
  let pending = Promise.resolve();

  /** Reloads policy and invalidates active approvals when its parsed value or load status changes. */
  const refreshConfig = () => {
    loadResult = loadConfigResult();
    const current = JSON.stringify(loadResult);

    if (current !== policy) {
      revision += 1;
      policy = current;
    }
  };

  pi.on("session_shutdown", () => {
    session.abort();
    revision += 1;
  });

  pi.on("session_start", (_event, ctx) => {
    session.abort();
    session = new AbortController();
    revision += 1;
    ensureConfig();
    refreshConfig();
    const path = configPath();
    const ruleCount = Object.keys(loadResult.config.operations).length;

    if (loadResult.status === "loaded" && ruleCount === 0) {
      ctx.ui.notify(
        `pi-gate: ${path} is empty; no commands are gated. Add rules to the "operations" object to start gating.`,
        "warning",
      );
    } else if (loadResult.status === "failed") {
      ctx.ui.notify(
        "pi-gate: configuration exists but could not be loaded; prompting for all commands until it is fixed.",
        "warning",
      );
    } else if (loadResult.status === "missing") {
      ctx.ui.notify(
        `pi-gate: no configuration found at ${path}; all commands are allowed until it is created.`,
        "warning",
      );
    }
  });

  pi.on("tool_call", (event, ctx) => {
    // Capture ownership before queueing so old calls cannot enter a replacement session.
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, session.signal]) : session.signal;

    // Pi can dispatch sibling tools concurrently; never overlap approval dialogs.
    /**
     * Returns a terminating block result for denied calls, or undefined to allow;
     * UI errors propagate.
     */
    const run = async (): Promise<ToolCallEventResult | undefined> => {
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

      if (signal.aborted) {
        return {
          block: true,
          reason: "pi-gate: approval cancelled; command not run.",
          terminate: true,
        };
      }

      refreshConfig();

      const match = configChange
        ? { pattern: "gate config change requires approval", action: "prompt" as const }
        : loadResult.status === "failed"
          ? { pattern: "configuration unavailable", action: "prompt" as const }
          : resolveRule(command, loadResult.config.operations);

      if (match === null || match.action === "allow") return undefined;
      const rule = configChange ? CONFIG_CHANGE_REASON : formatRule(match);

      if (match.action === "block") {
        const reason = `pi-gate: command blocked by rule "${reasonRuleName(match.pattern)}". Ask the user before proceeding.`;

        if (ctx.hasUI) ctx.ui.notify(reason, "warning");

        return { block: true, reason, terminate: true };
      }

      if (!ctx.hasUI) {
        return {
          block: true,
          reason: configChange
            ? CONFIG_CHANGE_REASON
            : `pi-gate: rule "${reasonRuleName(match.pattern)}" needs approval but no UI is available. Ask the user before proceeding.`,
          terminate: true,
        };
      }

      const promptRevision = revision;

      reportHerdrBlocked(pi, ctx, true);
      let choice: string | undefined;
      let timedOut = false;
      const timeoutMs = loadResult.config.promptTimeoutMs;

      const promptCommand = configChange
        ? `  ${formatCommandForDisplay(command)}`
        : formatPromptCommand(command, match.pattern);

      try {
        const promptStartedAt = Date.now();
        choice = await selectApproval(ctx, timeoutMs, signal, promptCommand, rule, !configChange);
        // Pi returns undefined for both dismissal and timeout; elapsed time separates the timeout case.
        timedOut = choice === undefined && Date.now() - promptStartedAt >= timeoutMs;
      } finally {
        reportHerdrBlocked(pi, ctx, false);
      }

      refreshConfig();

      if (signal.aborted || revision !== promptRevision) {
        return {
          block: true,
          reason:
            "pi-gate: approval cancelled or policy changed; command not run. Ask the user whether to retry.",
          terminate: true,
        };
      }

      if (choice !== "Allow") {
        return {
          block: true,
          reason: timedOut
            ? timeoutReason(match.pattern, timeoutMs)
            : configChange
              ? CONFIG_CHANGE_REASON
              : `pi-gate: command not run because approval was denied. Ask the user before retrying (rule "${reasonRuleName(match.pattern)}").`,
          terminate: true,
        };
      }

      return undefined;
    };

    const result = pending.then(run);
    pending = result.then(
      () => undefined,
      () => undefined,
    );

    return result;
  });
}
