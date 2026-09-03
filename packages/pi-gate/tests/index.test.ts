import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piGate, {
  ensureConfig,
  formatCommandForDisplay,
  loadConfig,
  parseConfig,
  resolveAction,
  resolveRule,
  CONFIG_SCHEMA_URL,
  DEFAULT_PROMPT_TIMEOUT_MS,
  MAX_DISPLAY_COMMAND_CHARACTERS,
  MAX_DISPLAY_COMMAND_LINES,
  MAX_RULE_COUNT,
  MAX_RULE_PATTERN_LENGTH,
  type Action,
} from "../src/index";

interface BashToolCallEvent {
  toolName: "bash";
  toolCallId: string;
  input: { command: string };
}

interface ReadToolCallEvent {
  toolName: "read";
  toolCallId: string;
  input: { path: string };
}

type ToolCallEvent = BashToolCallEvent | ReadToolCallEvent;

type ToolCallResult = { block: true; reason: string; terminate: true } | undefined;

interface SessionStartEvent {
  reason: string;
  previousSessionFile?: string;
}

type NotifyLevel = "info" | "warning" | "error";

interface UiState {
  notifyCalls: Array<{ text: string; level: NotifyLevel }>;
  selectCalls: Array<{
    prompt: string;
    options: readonly string[];
    settings: { timeout?: number } | undefined;
  }>;
  selectResponse: string | undefined;
}

interface FakeUi {
  hasUI: boolean;
  notify: (text: string, level: NotifyLevel) => void;
  select: (
    prompt: string,
    options: readonly string[],
    settings?: { timeout?: number },
  ) => Promise<string | undefined>;
}

interface FakeContext {
  ui: FakeUi;
  hasUI: boolean;
  mode: "tui" | "rpc" | "json" | "print";
}

// SAFETY: pi.on accepts variably-typed handlers across many event overloads; the
// monorepo test convention (pi-nested-agent-md) captures them as `any` and replays
// with hand-built inputs. We narrow to typed handlers only at the call site.
type CapturedHandler = (event: any, context: any) => any;

type SessionStartHandler = (event: SessionStartEvent, context: FakeContext) => Promise<void> | void;
type ToolCallHandler = (
  event: ToolCallEvent,
  context: FakeContext,
) => Promise<ToolCallResult> | ToolCallResult;

interface RecordedHandlers {
  sessionStart: SessionStartHandler | undefined;
  toolCall: ToolCallHandler | undefined;
}

interface ExtensionInstall {
  uiState: UiState;
  ctx: FakeContext;
  handlers: RecordedHandlers;
}

interface ContextWithUi {
  ctx: FakeContext;
  uiState: UiState;
}

interface ExtensionFactory {
  install: () => ExtensionInstall;
}

function createUi(state: UiState, hasUI: boolean): FakeUi {
  return {
    hasUI,
    notify: (text, level) => {
      state.notifyCalls.push({ text, level });
    },
    select: async (prompt, options, settings) => {
      state.selectCalls.push({ prompt, options, settings });
      return state.selectResponse;
    },
  };
}

function createExtensionContext(
  hasUI: boolean,
  mode: FakeContext["mode"] = hasUI ? "tui" : "print",
): ContextWithUi {
  const uiState: UiState = {
    notifyCalls: [],
    selectCalls: [],
    selectResponse: undefined,
  };
  const ctx: FakeContext = { ui: createUi(uiState, hasUI), hasUI, mode };
  return { ctx, uiState };
}

function makeExtension(): ExtensionFactory {
  const handlers: RecordedHandlers = { sessionStart: undefined, toolCall: undefined };
  // SAFETY: the test only exercises the `on` method; the rest of ExtensionAPI is unused.
  const pi = {
    on(name: string, handler: CapturedHandler) {
      if (name === "session_start") {
        // SAFETY: the extension registers a SessionStartHandler for `session_start`.
        handlers.sessionStart = handler as SessionStartHandler;
      } else if (name === "tool_call") {
        // SAFETY: the extension registers a ToolCallHandler for `tool_call`.
        handlers.toolCall = handler as ToolCallHandler;
      }
    },
  } as ExtensionAPI;
  const install = (): ExtensionInstall => {
    piGate(pi);
    const { ctx, uiState } = createExtensionContext(true);
    return { ctx, uiState, handlers };
  };
  return { install };
}

function setConfig(content: string | null): void {
  const dir = process.env.PI_CODING_AGENT_DIR;
  if (!dir) throw new Error("PI_CODING_AGENT_DIR must be set in tests");
  if (content === null) {
    try {
      rmSync(join(dir, "pi-gate.json"), { force: true });
    } catch {
      // ignore
    }
    return;
  }
  writeFileSync(join(dir, "pi-gate.json"), content, "utf-8");
}

let workDir: string;
const originalEnv = process.env.PI_CODING_AGENT_DIR;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "pi-gate-test-"));
  process.env.PI_CODING_AGENT_DIR = workDir;
});

afterEach(() => {
  if (originalEnv !== undefined) {
    process.env.PI_CODING_AGENT_DIR = originalEnv;
  } else {
    delete process.env.PI_CODING_AGENT_DIR;
  }
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("parseConfig", () => {
  const emptyConfig = { operations: {}, promptTimeoutMs: DEFAULT_PROMPT_TIMEOUT_MS };

  it("returns an empty configuration for invalid JSON", () => {
    expect(parseConfig("{not valid")).toEqual(emptyConfig);
  });

  it("returns an empty configuration for a non-object root", () => {
    expect(parseConfig('"a string"')).toEqual(emptyConfig);
    expect(parseConfig("42")).toEqual(emptyConfig);
    expect(parseConfig("null")).toEqual(emptyConfig);
    expect(parseConfig("[1, 2, 3]")).toEqual(emptyConfig);
  });

  it("returns an empty configuration when operations is missing", () => {
    expect(parseConfig("{}")).toEqual(emptyConfig);
    expect(parseConfig('{"other": []}')).toEqual(emptyConfig);
  });

  it("returns an empty configuration when operations is not an object", () => {
    expect(parseConfig('{"operations": []}')).toEqual(emptyConfig);
    expect(parseConfig('{"operations": "nope"}')).toEqual(emptyConfig);
  });

  it("accepts a positive prompt timeout up to one day", () => {
    expect(parseConfig('{"promptTimeoutMs":15000,"operations":{}}').promptTimeoutMs).toBe(15000);
    expect(parseConfig('{"promptTimeoutMs":86400000,"operations":{}}').promptTimeoutMs).toBe(
      86_400_000,
    );
  });

  it("uses the default prompt timeout for invalid values", () => {
    for (const value of [0, -1, 1.5, 86_400_001, "1000", null]) {
      const config = parseConfig(JSON.stringify({ promptTimeoutMs: value, operations: {} }));
      expect(config.promptTimeoutMs).toBe(DEFAULT_PROMPT_TIMEOUT_MS);
    }
  });

  it("preserves valid rules", () => {
    const result = parseConfig(
      JSON.stringify({
        operations: {
          "rm -rf": "prompt",
          sudo: "block",
          "git push": "allow",
        },
      }),
    );
    expect(result.operations).toEqual({
      "rm -rf": "prompt",
      sudo: "block",
      "git push": "allow",
    });
  });

  it("skips rules with invalid actions", () => {
    const result = parseConfig(
      JSON.stringify({
        operations: {
          "rm -rf": "prompt",
          "bad-action": "maybe",
          "not-a-string": 42,
        },
      }),
    );
    expect(result.operations).toEqual({ "rm -rf": "prompt" });
  });

  it("skips empty and excessively long patterns", () => {
    const tooLong = "x".repeat(MAX_RULE_PATTERN_LENGTH + 1);
    const result = parseConfig(
      JSON.stringify({ operations: { "": "block", valid: "prompt", [tooLong]: "allow" } }),
    );
    expect(result.operations).toEqual({ valid: "prompt" });
  });

  it("caps the number of accepted rules", () => {
    const operations = Object.fromEntries(
      Array.from({ length: MAX_RULE_COUNT + 5 }, (_, index) => [`rule-${index}`, "block"]),
    );
    expect(Object.keys(parseConfig(JSON.stringify({ operations })).operations)).toHaveLength(
      MAX_RULE_COUNT,
    );
  });
});

describe("formatCommandForDisplay", () => {
  it("normalizes line endings and visibly escapes terminal and bidi controls", () => {
    expect(formatCommandForDisplay("one\r\ntwo\r\x1b[31m\u202Etxt\0")).toBe(
      "one\ntwo\n\\u{001b}[31m\\u{202e}txt\\u{0000}",
    );
  });

  it("bounds displayed command characters without changing the prefix", () => {
    const result = formatCommandForDisplay("x".repeat(MAX_DISPLAY_COMMAND_CHARACTERS + 1));
    expect(result).toContain("x".repeat(MAX_DISPLAY_COMMAND_CHARACTERS));
    expect(result).toContain("[command display truncated]");
  });

  it("bounds displayed command lines", () => {
    const result = formatCommandForDisplay(
      Array.from({ length: MAX_DISPLAY_COMMAND_LINES + 1 }, (_, index) => `line-${index}`).join(
        "\n",
      ),
    );
    expect(result.split("\n")).toHaveLength(MAX_DISPLAY_COMMAND_LINES + 1);
    expect(result).toContain("[command display truncated]");
    expect(result).not.toContain(`line-${MAX_DISPLAY_COMMAND_LINES}`);
  });
});

describe("loadConfig", () => {
  it("returns an empty configuration when the file is missing", () => {
    expect(loadConfig()).toEqual({
      operations: {},
      promptTimeoutMs: DEFAULT_PROMPT_TIMEOUT_MS,
    });
  });

  it("returns the parsed configuration when the file is present", () => {
    setConfig(JSON.stringify({ operations: { sudo: "block" }, promptTimeoutMs: 5000 }));
    expect(loadConfig()).toEqual({ operations: { sudo: "block" }, promptTimeoutMs: 5000 });
  });

  it("returns an empty configuration when the file is malformed", () => {
    setConfig("{ not valid");
    expect(loadConfig()).toEqual({
      operations: {},
      promptTimeoutMs: DEFAULT_PROMPT_TIMEOUT_MS,
    });
  });
});

describe("resolveRule", () => {
  it("returns the matching pattern and action", () => {
    expect(resolveRule("sudo apt update", { sudo: "block" })).toEqual({
      pattern: "sudo",
      action: "block",
    });
  });

  it("returns the longest matching rule", () => {
    expect(
      resolveRule("rm -rf /", { rm: "block", "rm -rf": "prompt", "rm -rf /": "allow" }),
    ).toEqual({ pattern: "rm -rf /", action: "allow" });
  });

  it("returns null when no rule matches", () => {
    expect(resolveRule("ls -la", { sudo: "block" })).toBeNull();
  });
});

describe("resolveAction", () => {
  it("returns null when no rule matches", () => {
    expect(resolveAction("ls -la", { sudo: "block" })).toBeNull();
  });

  it("returns the action of a single matching rule", () => {
    expect(resolveAction("sudo apt update", { sudo: "block" })).toBe<Action>("block");
    expect(resolveAction("rm -rf node_modules", { "rm -rf": "prompt" })).toBe<Action>("prompt");
  });

  it("picks the longest pattern when several rules match", () => {
    const action = resolveAction("rm -rf /", {
      rm: "block",
      "rm -rf": "prompt",
      "rm -rf /": "allow",
    });
    expect(action).toBe<Action>("allow");
  });

  it("uses length, not declaration order, as the tiebreaker", () => {
    const action = resolveAction("rm -rf /", {
      "rm -rf /": "allow",
      "rm -rf": "block",
    });
    expect(action).toBe<Action>("allow");
  });

  it("returns null for an empty rule set", () => {
    expect(resolveAction("anything", {})).toBeNull();
  });
});

describe("ensureConfig", () => {
  it("writes the default configuration on first run", () => {
    ensureConfig();
    const path = join(workDir, "pi-gate.json");
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({
      $schema: CONFIG_SCHEMA_URL,
      promptTimeoutMs: DEFAULT_PROMPT_TIMEOUT_MS,
      operations: {
        "rm -rf": "prompt",
        sudo: "prompt",
        "sudo apt update": "allow",
        "chmod 777": "block",
        "corepack enable": "block",
      },
    });
  });

  it("does not overwrite an existing configuration", () => {
    const path = join(workDir, "pi-gate.json");
    writeFileSync(path, '{"operations":{"x":"block"}}', "utf-8");
    ensureConfig();
    expect(readFileSync(path, "utf-8")).toBe('{"operations":{"x":"block"}}');
  });
});

describe("piGate extension", () => {
  it("registers exactly session_start and tool_call", () => {
    const ext = makeExtension();
    const { handlers } = ext.install();
    // SAFETY: the captured handlers list is keyed by the names the extension registered.
    expect(handlers.sessionStart).toBeDefined();
    expect(handlers.toolCall).toBeDefined();
  });

  describe("session_start notification", () => {
    it("creates and loads a default config with starter rules when the file is missing", async () => {
      const { ctx, uiState, handlers } = makeExtension().install();
      await handlers.sessionStart!({ reason: "startup" }, ctx);
      expect(uiState.notifyCalls).toHaveLength(1);
      expect(uiState.notifyCalls[0]?.level).toBe("info");
      expect(uiState.notifyCalls[0]?.text).toContain("5 operation rules");
      expect(loadConfig()).toEqual({
        promptTimeoutMs: DEFAULT_PROMPT_TIMEOUT_MS,
        operations: {
          "rm -rf": "prompt",
          sudo: "prompt",
          "sudo apt update": "allow",
          "chmod 777": "block",
          "corepack enable": "block",
        },
      });
    });

    it("warns when the config file exists but has no rules", async () => {
      setConfig('{"operations":{}}');
      const { ctx, uiState, handlers } = makeExtension().install();
      await handlers.sessionStart!({ reason: "startup" }, ctx);
      expect(uiState.notifyCalls).toHaveLength(1);
      expect(uiState.notifyCalls[0]?.level).toBe("warning");
      expect(uiState.notifyCalls[0]?.text).toContain("is empty");
    });

    it("informs when the config file has rules", async () => {
      setConfig(JSON.stringify({ operations: { sudo: "block", "rm -rf": "prompt" } }));
      const { ctx, uiState, handlers } = makeExtension().install();
      await handlers.sessionStart!({ reason: "startup" }, ctx);
      expect(uiState.notifyCalls).toHaveLength(1);
      expect(uiState.notifyCalls[0]?.level).toBe("info");
      expect(uiState.notifyCalls[0]?.text).toContain("2 operation rules");
    });

    it("uses singular phrasing for a single rule", async () => {
      setConfig(JSON.stringify({ operations: { sudo: "block" } }));
      const { ctx, uiState, handlers } = makeExtension().install();
      await handlers.sessionStart!({ reason: "startup" }, ctx);
      expect(uiState.notifyCalls[0]?.text).toContain("1 operation rule ");
    });
  });

  describe("tool_call gating", () => {
    function bashEvent(command: string): BashToolCallEvent {
      return { toolName: "bash", toolCallId: "t1", input: { command } };
    }

    it("ignores non-bash tools", async () => {
      setConfig(JSON.stringify({ operations: { sudo: "block" } }));
      const { ctx, handlers } = makeExtension().install();
      const readEvent: ReadToolCallEvent = {
        toolName: "read",
        toolCallId: "t1",
        input: { path: "/etc/passwd" },
      };
      const result = await handlers.toolCall!(readEvent, ctx);
      expect(result).toBeUndefined();
    });

    it("returns undefined when no rule matches", async () => {
      setConfig(JSON.stringify({ operations: { sudo: "block" } }));
      const { ctx, handlers } = makeExtension().install();
      const result = await handlers.toolCall!(bashEvent("ls -la"), ctx);
      expect(result).toBeUndefined();
    });

    it("returns undefined when all rules are empty", async () => {
      setConfig('{"operations":{}}');
      const { ctx, handlers } = makeExtension().install();
      const result = await handlers.toolCall!(bashEvent("sudo rm -rf /"), ctx);
      expect(result).toBeUndefined();
    });

    it("blocks commands matching a block rule and notifies in UI mode", async () => {
      setConfig(JSON.stringify({ operations: { sudo: "block" } }));
      const { ctx, uiState, handlers } = makeExtension().install();
      const result = await handlers.toolCall!(bashEvent("sudo apt update"), ctx);
      expect(result).toEqual({
        block: true,
        reason: 'pi-gate: command blocked by rule "sudo": "block"',
        terminate: true,
      });
      expect(uiState.notifyCalls).toEqual([
        { text: 'pi-gate: command blocked by rule "sudo": "block"', level: "warning" },
      ]);
    });

    it("blocks without a notify call in non-UI mode", async () => {
      setConfig(JSON.stringify({ operations: { sudo: "block" } }));
      const { handlers } = makeExtension().install();
      const { ctx, uiState } = createExtensionContext(false);
      const result = await handlers.toolCall!(bashEvent("sudo apt update"), ctx);
      expect(result).toEqual({
        block: true,
        reason: 'pi-gate: command blocked by rule "sudo": "block"',
        terminate: true,
      });
      expect(uiState.notifyCalls).toHaveLength(0);
    });

    it("prompts with the user in UI mode and respects the Allow choice", async () => {
      setConfig(JSON.stringify({ operations: { "rm -rf": "prompt" } }));
      const { ctx, uiState, handlers } = makeExtension().install();
      uiState.selectResponse = "Allow";
      const result = await handlers.toolCall!(bashEvent("rm -rf node_modules"), ctx);
      expect(result).toBeUndefined();
      expect(uiState.selectCalls).toEqual([
        {
          prompt:
            'pi-gate: allow this command?\n\n  rm -rf node_modules\n\nMatched rule: "rm -rf": "prompt"',
          options: ["Allow", "Deny"],
          settings: { timeout: DEFAULT_PROMPT_TIMEOUT_MS },
        },
      ]);
    });

    it("uses host-native selection in RPC mode", async () => {
      setConfig(JSON.stringify({ operations: { sudo: "prompt" } }));
      const { handlers } = makeExtension().install();
      const { ctx, uiState } = createExtensionContext(true, "rpc");
      uiState.selectResponse = "Allow";

      expect(await handlers.toolCall!(bashEvent("sudo apt update"), ctx)).toBeUndefined();
      expect(uiState.selectCalls).toHaveLength(1);
    });

    it("escapes controls and bounds only the command shown in the prompt", async () => {
      setConfig(JSON.stringify({ operations: { dangerous: "prompt" } }));
      const { ctx, uiState, handlers } = makeExtension().install();
      uiState.selectResponse = "Allow";
      const command = `dangerous \x1b[31m${"x".repeat(MAX_DISPLAY_COMMAND_CHARACTERS)}`;

      expect(await handlers.toolCall!(bashEvent(command), ctx)).toBeUndefined();
      expect(uiState.selectCalls[0]?.prompt).toContain("\\u{001b}[31m");
      expect(uiState.selectCalls[0]?.prompt).toContain("[command display truncated]");
      expect(uiState.selectCalls[0]?.prompt).not.toContain("\x1b");
    });

    it("prompts with the user and blocks on Deny", async () => {
      setConfig(JSON.stringify({ operations: { "rm -rf": "prompt" } }));
      const { ctx, uiState, handlers } = makeExtension().install();
      uiState.selectResponse = "Deny";
      const result = await handlers.toolCall!(bashEvent("rm -rf node_modules"), ctx);
      expect(result).toEqual({
        block: true,
        reason:
          'pi-gate: command denied, dismissed, or timed out after matching rule "rm -rf": "prompt"',
        terminate: true,
      });
    });

    it("auto-denies after the configured prompt timeout", async () => {
      setConfig(JSON.stringify({ operations: { "rm -rf": "prompt" }, promptTimeoutMs: 12_500 }));
      const { ctx, uiState, handlers } = makeExtension().install();
      const result = await handlers.toolCall!(bashEvent("rm -rf node_modules"), ctx);
      expect(uiState.selectCalls[0]?.settings).toEqual({ timeout: 12_500 });
      expect(result).toEqual({
        block: true,
        reason:
          'pi-gate: command denied, dismissed, or timed out after matching rule "rm -rf": "prompt"',
        terminate: true,
      });
    });

    it("blocks a prompt rule in non-UI mode without calling select", async () => {
      setConfig(JSON.stringify({ operations: { "rm -rf": "prompt" } }));
      const { handlers } = makeExtension().install();
      const { ctx, uiState } = createExtensionContext(false);
      const result = await handlers.toolCall!(bashEvent("rm -rf node_modules"), ctx);
      expect(result).toEqual({
        block: true,
        reason:
          'pi-gate: command blocked because rule "rm -rf": "prompt" requires a prompt, but no UI is available',
        terminate: true,
      });
      expect(uiState.selectCalls).toHaveLength(0);
    });

    it("treats allow as a pass-through even when other rules match", async () => {
      setConfig(JSON.stringify({ operations: { sudo: "block", "sudo apt": "allow" } }));
      const { ctx, handlers } = makeExtension().install();
      const result = await handlers.toolCall!(bashEvent("sudo apt update"), ctx);
      expect(result).toBeUndefined();
    });

    it("picks the longest pattern to resolve conflicts", async () => {
      setConfig(
        JSON.stringify({
          operations: { sudo: "block", "sudo apt": "allow", "sudo apt update": "block" },
        }),
      );
      const { ctx, handlers } = makeExtension().install();
      const blocked = await handlers.toolCall!(bashEvent("sudo apt update"), ctx);
      expect(blocked).toEqual({
        block: true,
        reason: 'pi-gate: command blocked by rule "sudo apt update": "block"',
        terminate: true,
      });
      const allowed = await handlers.toolCall!(bashEvent("sudo apt install foo"), ctx);
      expect(allowed).toBeUndefined();
    });

    it("accepts a typed bash event and reads the command from event.input", async () => {
      setConfig(JSON.stringify({ operations: { sudo: "block" } }));
      const { ctx, handlers } = makeExtension().install();
      const event: BashToolCallEvent = {
        toolName: "bash",
        toolCallId: "t1",
        input: { command: "sudo echo hi" },
      };
      // SAFETY: exercise the type-narrowing helper the extension actually uses.
      // SAFETY: isToolCallEventType accepts a generic over the expected event shape; our locally-built event satisfies the runtime shape but TypeScript cannot infer it from the local type.
      if (!isToolCallEventType("bash", event as never)) throw new Error("expected bash event");

      const result = await handlers.toolCall!(event, ctx);
      expect(result).toEqual({
        block: true,
        reason: 'pi-gate: command blocked by rule "sudo": "block"',
        terminate: true,
      });
    });
  });
});
