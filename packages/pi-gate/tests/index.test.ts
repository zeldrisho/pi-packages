import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  isToolCallEventType,
  type ExtensionAPI,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import piGate, {
  ensureConfig,
  loadConfig,
  loadConfigResult,
  DEFAULT_PROMPT_TIMEOUT_MS,
  MAX_DISPLAY_COMMAND_CHARACTERS,
} from "../src/index";

interface BashToolCallEvent {
  toolName: "bash";
  toolCallId: string;
  input: { command: string };
}

interface PathToolCallEvent {
  toolName: "read" | "write" | "edit";
  toolCallId: string;
  input: { path: string };
}

type ToolCallEvent = BashToolCallEvent | PathToolCallEvent;

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
  selectDelayMs: number | undefined;
  onSelect?: () => void;
}

interface FakeUi {
  hasUI: boolean;
  custom?: <T>(
    factory: (
      tui: TUI,
      theme: Theme,
      keybindings: KeybindingsManager,
      done: (result: T) => void,
    ) => Component | Promise<Component>,
  ) => Promise<T>;
  notify: (text: string, level: NotifyLevel) => void;
  select: (
    prompt: string,
    options: readonly string[],
    settings?: { timeout?: number; signal?: AbortSignal },
  ) => Promise<string | undefined>;
}

interface FakeContext {
  ui: FakeUi;
  hasUI: boolean;
  mode: "tui" | "rpc" | "json" | "print";
  signal?: AbortSignal;
}

// SAFETY: pi.on accepts variably-typed handlers across many event overloads; the
// monorepo test convention captures them as `any` and replays
// with hand-built inputs. We narrow to typed handlers only at the call site.
type CapturedHandler = (event: any, context: any) => any;

type SessionStartHandler = (event: SessionStartEvent, context: FakeContext) => Promise<void> | void;

type ToolCallHandler = (
  event: ToolCallEvent,
  context: FakeContext,
) => Promise<ToolCallResult> | ToolCallResult;

interface RecordedHandlers {
  sessionStart: SessionStartHandler | undefined;
  sessionShutdown: (() => void) | undefined;
  toolCall: ToolCallHandler | undefined;
}

interface HerdrBlockedEvent {
  active: boolean;
  label: string;
}

interface ExtensionInstall {
  uiState: UiState;
  ctx: FakeContext;
  handlers: RecordedHandlers;
  herdrEvents: HerdrBlockedEvent[];
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
      state.onSelect?.();

      if (state.selectDelayMs !== undefined) {
        await new Promise<void>((resolve) => setTimeout(resolve, state.selectDelayMs));
      }

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
    selectDelayMs: undefined,
  };

  const ctx: FakeContext = {
    ui: createUi(uiState, hasUI),
    hasUI,
    mode,
  };

  return { ctx, uiState };
}

function makeExtension(): ExtensionFactory {
  const handlers: RecordedHandlers = {
    sessionStart: undefined,
    sessionShutdown: undefined,
    toolCall: undefined,
  };

  const herdrEvents: HerdrBlockedEvent[] = [];

  // SAFETY: the test only exercises the `on` method; the rest of ExtensionAPI is unused.
  const pi = {
    events: {
      emit(name: string, data: HerdrBlockedEvent) {
        if (name === "herdr:blocked") herdrEvents.push(data);
      },
    },
    on(name: string, handler: CapturedHandler) {
      if (name === "session_start") {
        // SAFETY: the extension registers a SessionStartHandler for `session_start`.
        handlers.sessionStart = handler as SessionStartHandler;
      } else if (name === "session_shutdown") {
        handlers.sessionShutdown = () => handler({}, undefined);
      } else if (name === "tool_call") {
        // SAFETY: the extension registers a ToolCallHandler for `tool_call`.
        handlers.toolCall = handler as ToolCallHandler;
      }
    },
  } as ExtensionAPI;

  const install = (): ExtensionInstall => {
    piGate(pi);
    const { ctx, uiState } = createExtensionContext(true);

    return { ctx, uiState, handlers, herdrEvents };
  };

  return { install };
}

/** Writes the test gate configuration, or removes it when content is null. */
function setConfig(content: string | null): void {
  const dir = process.env.PI_CODING_AGENT_DIR;

  if (!dir) throw new Error("PI_CODING_AGENT_DIR must be set in tests");

  if (content === null) {
    try {
      rmSync(join(dir, "gate.json"), { force: true });
    } catch {
      // ignore
    }

    return;
  }

  writeFileSync(join(dir, "gate.json"), content, "utf-8");
}

let workDir: string;

const originalEnv = process.env.PI_CODING_AGENT_DIR;

const originalHerdrEnv = process.env.HERDR_ENV;

const originalHerdrSocketPath = process.env.HERDR_SOCKET_PATH;

const originalHerdrPaneId = process.env.HERDR_PANE_ID;

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

  for (const [name, value] of [
    ["HERDR_ENV", originalHerdrEnv],
    ["HERDR_SOCKET_PATH", originalHerdrSocketPath],
    ["HERDR_PANE_ID", originalHerdrPaneId],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("legacy configuration fallback", () => {
  it("loads legacy rules without creating gate.json and reports the legacy path", async () => {
    const path = join(workDir, "pi-gate.json");
    const content = '{"operations":{"sudo":"block"},"promptTimeoutMs":5000}';
    writeFileSync(path, content);
    const { ctx, uiState, handlers } = makeExtension().install();

    expect(loadConfig()).toEqual({ operations: { sudo: "block" }, promptTimeoutMs: 5000 });
    expect(existsSync(join(workDir, "gate.json"))).toBe(false);
    expect(readFileSync(path, "utf-8")).toBe(content);
    await handlers.sessionStart!({ reason: "startup" }, ctx);
    expect(uiState.notifyCalls).toHaveLength(0);
    expect(
      await handlers.toolCall!(
        { toolName: "bash", toolCallId: "legacy", input: { command: "sudo true" } },
        ctx,
      ),
    ).toMatchObject({ block: true });
  });

  it("prefers gate.json without merging or modifying legacy rules", () => {
    const path = join(workDir, "pi-gate.json");
    const content = '{"operations":{"sudo":"block","rm":"block"}}';
    writeFileSync(path, content);
    setConfig('{"operations":{"sudo":"allow"}}');
    ensureConfig();

    expect(loadConfig().operations).toEqual({ sudo: "allow" });
    expect(readFileSync(path, "utf-8")).toBe(content);
  });

  it.each(["malformed", "unreadable"])(
    "does not fall back when gate.json is %s",
    async (failure) => {
      writeFileSync(join(workDir, "pi-gate.json"), '{"operations":{"echo":"allow"}}');

      if (failure === "malformed") setConfig("{ invalid");
      else mkdirSync(join(workDir, "gate.json"));
      const { ctx, uiState, handlers } = makeExtension().install();

      expect(loadConfigResult().status).toBe("failed");
      expect(
        await handlers.toolCall!(
          { toolName: "bash", toolCallId: "failed", input: { command: "echo test" } },
          ctx,
        ),
      ).toMatchObject({ block: true });
      expect(uiState.selectCalls).toHaveLength(1);
    },
  );

  it("preserves malformed legacy configuration instead of seeding defaults", () => {
    const path = join(workDir, "pi-gate.json");
    writeFileSync(path, "{ invalid");
    ensureConfig();

    expect(loadConfigResult().status).toBe("failed");
    expect(existsSync(join(workDir, "gate.json"))).toBe(false);
    expect(readFileSync(path, "utf-8")).toBe("{ invalid");
  });
});

describe("piGate extension", () => {
  it("registers session lifecycle and tool_call handlers", () => {
    const ext = makeExtension();
    const { handlers } = ext.install();
    // SAFETY: the captured handlers list is keyed by the names the extension registered.
    expect(handlers.sessionStart).toBeDefined();
    expect(handlers.sessionShutdown).toBeDefined();
    expect(handlers.toolCall).toBeDefined();
  });

  describe("session_start notification", () => {
    it("does not create configuration until a session starts", async () => {
      const { ctx, handlers } = makeExtension().install();
      expect(existsSync(join(workDir, "gate.json"))).toBe(false);
      await handlers.sessionStart!({ reason: "startup" }, ctx);
      expect(existsSync(join(workDir, "gate.json"))).toBe(true);
    });

    it("allows commands when no config has ever existed and creation fails", async () => {
      const blockedAgentDir = join(workDir, "not-a-directory");
      writeFileSync(blockedAgentDir, "not a directory", "utf-8");
      process.env.PI_CODING_AGENT_DIR = blockedAgentDir;
      const { ctx, uiState, handlers } = makeExtension().install();

      await handlers.sessionStart!({ reason: "startup" }, ctx);
      expect(uiState.notifyCalls[0]).toEqual({
        text: expect.stringContaining("no configuration found"),
        level: "warning",
      });
      expect(
        await handlers.toolCall!(
          {
            toolName: "bash",
            toolCallId: "t1",
            input: { command: "sudo rm -rf /" },
          },
          ctx,
        ),
      ).toBeUndefined();
    });

    it("prompts for every command when an existing config is malformed", async () => {
      setConfig("{ not valid");
      const { ctx, uiState, handlers } = makeExtension().install();

      await handlers.sessionStart!({ reason: "startup" }, ctx);
      expect(uiState.notifyCalls[0]).toEqual({
        text: expect.stringContaining("configuration exists but could not be loaded"),
        level: "warning",
      });

      const result = await handlers.toolCall!(
        {
          toolName: "bash",
          toolCallId: "t1",
          input: { command: "sudo rm -rf /" },
        },
        ctx,
      );

      expect(uiState.selectCalls).toHaveLength(1);
      expect(result).toEqual({
        block: true,
        reason:
          'pi-gate: command not run because approval was denied. Ask the user before retrying (rule "configuration unavailable").',
        terminate: true,
      });
    });

    it("creates and loads a default config with starter rules when the file is missing", async () => {
      const { ctx, uiState, handlers } = makeExtension().install();
      await handlers.sessionStart!({ reason: "startup" }, ctx);
      expect(uiState.notifyCalls).toHaveLength(0);
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

    it("does not notify when the config file has rules", async () => {
      setConfig(JSON.stringify({ operations: { sudo: "block", "rm -rf": "prompt" } }));
      const { ctx, uiState, handlers } = makeExtension().install();
      await handlers.sessionStart!({ reason: "startup" }, ctx);
      expect(uiState.notifyCalls).toHaveLength(0);
    });

    it("does not notify when a single rule is loaded", async () => {
      setConfig(JSON.stringify({ operations: { sudo: "block" } }));
      const { ctx, uiState, handlers } = makeExtension().install();
      await handlers.sessionStart!({ reason: "startup" }, ctx);
      expect(uiState.notifyCalls).toHaveLength(0);
    });
  });

  describe("tool_call gating", () => {
    function bashEvent(command: string): BashToolCallEvent {
      return { toolName: "bash", toolCallId: "t1", input: { command } };
    }

    it("ignores non-bash tools", async () => {
      setConfig(JSON.stringify({ operations: { sudo: "block" } }));
      const { ctx, handlers } = makeExtension().install();

      const readEvent: PathToolCallEvent = {
        toolName: "read",
        toolCallId: "t1",
        input: { path: "/etc/passwd" },
      };

      const result = await handlers.toolCall!(readEvent, ctx);
      expect(result).toBeUndefined();
    });

    it("prompts for write and edit calls targeting either config file", async () => {
      const gatePath = join(workDir, "gate.json");
      const legacyPath = join(workDir, "pi-gate.json");
      const { ctx, handlers } = makeExtension().install();

      for (const [toolName, path] of [
        ["write", gatePath],
        ["edit", legacyPath],
      ] as const) {
        const result = await handlers.toolCall!(
          {
            toolName,
            toolCallId: toolName,
            input: { path },
          },
          ctx,
        );

        expect(result).toEqual({
          block: true,
          reason: "pi-gate: gate config change requires approval",
          terminate: true,
        });
      }

      expect(
        await handlers.toolCall!(
          {
            toolName: "write",
            toolCallId: "other",
            input: { path: join(workDir, "notes.txt") },
          },
          ctx,
        ),
      ).toBeUndefined();
      expect(
        await handlers.toolCall!(bashEvent("echo hi > $PI_CODING_AGENT_DIR/gate.json"), ctx),
      ).toEqual({
        block: true,
        reason: "pi-gate: gate config change requires approval",
        terminate: true,
      });
    });

    it("uses the themed custom approval UI in TUI mode", async () => {
      setConfig(JSON.stringify({ operations: { sudo: "prompt" } }));
      const { ctx, handlers } = makeExtension().install();

      ctx.ui.custom = <T>(
        factory: (
          tui: TUI,
          theme: Theme,
          keybindings: KeybindingsManager,
          done: (result: T) => void,
        ) => Component | Promise<Component>,
      ) =>
        new Promise<T>((resolve) => {
          // SAFETY: The custom approval only calls requestRender() on the TUI.
          const tui = Object.assign(Object.create(null), { requestRender() {} }) as TUI;

          // SAFETY: The approval component uses only these theme helpers.
          const theme = Object.assign(Object.create(null), {
            style: (text: string) => text,
            bg: (_color: string, text: string) => text,
            bold: (text: string) => text,
          }) as Theme;

          // SAFETY: The test drives the approval component using only keybinding matches().
          const keybindings = Object.assign(Object.create(null), {
            matches: (input: string, action: string) =>
              input === "ENTER" && action === "tui.select.confirm",
          }) as KeybindingsManager;

          const component = factory(tui, theme, keybindings, resolve);
          void Promise.resolve(component).then(
            (resolved) => resolved.handleInput?.("ENTER"),
            () => undefined,
          );
        });

      expect(await handlers.toolCall!(bashEvent("sudo true"), ctx)).toBeUndefined();
    });

    it("returns undefined when no rule matches", async () => {
      setConfig(JSON.stringify({ operations: { sudo: "block" } }));
      const { ctx, handlers } = makeExtension().install();
      const result = await handlers.toolCall!(bashEvent("ls -la"), ctx);
      expect(result).toBeUndefined();
    });

    it.each(["echo sudo", "printf '%s' sudo", "git checkout-index --help"])(
      "does not prompt for literal output or partial command names: %s",
      async (command) => {
        setConfig(JSON.stringify({ operations: { sudo: "prompt", "git checkout": "prompt" } }));
        const { ctx, uiState, handlers } = makeExtension().install();

        expect(await handlers.toolCall!(bashEvent(command), ctx)).toBeUndefined();
        expect(uiState.selectCalls).toHaveLength(0);
      },
    );

    it.each(["echo sudo; sudo true", "echo sudo | sh", "echo $(sudo true)"])(
      "retains approval for real calls and uncertain shell syntax: %s",
      async (command) => {
        setConfig(JSON.stringify({ operations: { sudo: "prompt" } }));
        const { ctx, uiState, handlers } = makeExtension().install();

        expect(await handlers.toolCall!(bashEvent(command), ctx)).toMatchObject({ block: true });
        expect(uiState.selectCalls).toHaveLength(1);
      },
    );

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
        reason: 'pi-gate: command blocked by rule "sudo". Ask the user before proceeding.',
        terminate: true,
      });
      expect(uiState.notifyCalls).toEqual([
        {
          text: 'pi-gate: command blocked by rule "sudo". Ask the user before proceeding.',
          level: "warning",
        },
      ]);
    });

    it("blocks without a notify call in non-UI mode", async () => {
      setConfig(JSON.stringify({ operations: { sudo: "block" } }));
      const { handlers } = makeExtension().install();
      const { ctx, uiState } = createExtensionContext(false);
      const result = await handlers.toolCall!(bashEvent("sudo apt update"), ctx);
      expect(result).toEqual({
        block: true,
        reason: 'pi-gate: command blocked by rule "sudo". Ask the user before proceeding.',
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
            'pi-gate: allow this command?\n\n  »rm -rf« node_modules\n\nMatched rule: "rm -rf": "prompt"\nMatched command text is wrapped in »…«',
          options: ["Allow", "Deny"],
          settings: { timeout: DEFAULT_PROMPT_TIMEOUT_MS, signal: expect.any(AbortSignal) },
        },
      ]);
    });

    it("reports the approval popup to Herdr and clears it after the choice", async () => {
      process.env.HERDR_ENV = "1";
      process.env.HERDR_SOCKET_PATH = "/tmp/herdr.sock";
      process.env.HERDR_PANE_ID = "w1:p1";
      setConfig(JSON.stringify({ operations: { sudo: "prompt" } }));
      const extension = makeExtension().install();
      extension.uiState.selectResponse = "Allow";

      expect(
        await extension.handlers.toolCall!(bashEvent("sudo echo hi"), extension.ctx),
      ).toBeUndefined();
      expect(extension.herdrEvents).toEqual([
        { active: true, label: "pi-gate: approval required" },
        { active: false, label: "pi-gate: approval required" },
      ]);
    });

    it("keeps approval prompts working when Herdr is not configured", async () => {
      delete process.env.HERDR_ENV;
      delete process.env.HERDR_SOCKET_PATH;
      delete process.env.HERDR_PANE_ID;
      setConfig(JSON.stringify({ operations: { sudo: "prompt" } }));
      const extension = makeExtension().install();
      extension.uiState.selectResponse = "Allow";

      expect(
        await extension.handlers.toolCall!(bashEvent("sudo echo hi"), extension.ctx),
      ).toBeUndefined();
      expect(extension.uiState.selectCalls).toHaveLength(1);
      expect(extension.herdrEvents).toEqual([]);
    });

    it("does not report to Herdr outside a TUI Herdr session", async () => {
      process.env.HERDR_ENV = "1";
      process.env.HERDR_SOCKET_PATH = "/tmp/herdr.sock";
      process.env.HERDR_PANE_ID = "w1:p1";
      setConfig(JSON.stringify({ operations: { sudo: "prompt" } }));
      const extension = makeExtension().install();
      const { ctx, uiState } = createExtensionContext(true, "rpc");
      uiState.selectResponse = "Allow";

      expect(await extension.handlers.toolCall!(bashEvent("sudo echo hi"), ctx)).toBeUndefined();
      expect(extension.herdrEvents).toEqual([]);
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
      expect(uiState.selectCalls[0]?.prompt).toContain("»dangerous« \\u{001b}[31m");
      expect(uiState.selectCalls[0]?.prompt).toMatch(/\[\d+ more characters hidden\]/u);
      expect(uiState.selectCalls[0]?.prompt).not.toContain("\x1b");
    });

    it("asks again for a repeated command unless gate.json allows it", async () => {
      setConfig(JSON.stringify({ operations: { sudo: "prompt" } }));
      const { ctx, uiState, handlers } = makeExtension().install();
      uiState.selectResponse = "Allow";
      await handlers.toolCall!(bashEvent("sudo echo hi"), ctx);
      await handlers.toolCall!(bashEvent("sudo echo hi"), ctx);
      expect(uiState.selectCalls).toHaveLength(2);
      setConfig(JSON.stringify({ operations: { sudo: "allow" } }));
      expect(await handlers.toolCall!(bashEvent("sudo echo hi"), ctx)).toBeUndefined();
      expect(uiState.selectCalls).toHaveLength(2);
    });

    it("reloads policy before each gated call", async () => {
      setConfig(JSON.stringify({ operations: { sudo: "prompt" } }));
      const { ctx, uiState, handlers } = makeExtension().install();
      uiState.selectResponse = "Allow";
      await handlers.toolCall!(bashEvent("sudo echo hi"), ctx);
      setConfig(JSON.stringify({ operations: { sudo: "block" } }));
      expect(await handlers.toolCall!(bashEvent("sudo echo hi"), ctx)).toMatchObject({
        block: true,
      });
      setConfig(JSON.stringify({ operations: { sudo: "prompt" } }));
      await handlers.toolCall!(bashEvent("sudo echo hi"), ctx);
      expect(uiState.selectCalls).toHaveLength(2);
    });

    it("serializes sibling prompts without remembering approvals", async () => {
      setConfig(JSON.stringify({ operations: { sudo: "prompt" } }));
      const { ctx, uiState, handlers } = makeExtension().install();
      let active = 0;
      let maximumActive = 0;
      ctx.ui.select = async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        active -= 1;

        return "Allow";
      };

      const results = await Promise.all([
        handlers.toolCall!(bashEvent("sudo echo hi"), ctx),
        handlers.toolCall!(bashEvent("sudo echo hi"), ctx),
      ]);

      expect(results).toEqual([undefined, undefined]);
      expect(maximumActive).toBe(1);
      expect(uiState.selectCalls).toHaveLength(0);
    });

    it.each(["abort", "session-change", "policy-change"])(
      "denies a stale prompt after %s",
      async (kind) => {
        setConfig(JSON.stringify({ operations: { sudo: "prompt" } }));
        const { ctx, uiState, handlers } = makeExtension().install();
        const controller = new AbortController();
        ctx.signal = controller.signal;
        uiState.selectResponse = "Allow";
        uiState.onSelect = () => {
          if (kind === "abort") controller.abort();
          else if (kind === "session-change")
            void handlers.sessionStart!({ reason: "switch" }, ctx);
          else setConfig(JSON.stringify({ operations: { sudo: "block" } }));
        };

        expect(await handlers.toolCall!(bashEvent("sudo echo hi"), ctx)).toMatchObject({
          block: true,
          reason: expect.stringContaining("cancelled or policy changed"),
        });
      },
    );

    it.each(["shutdown", "replacement"])(
      "cancels active and queued approvals on %s",
      async (kind) => {
        setConfig(JSON.stringify({ operations: { sudo: "prompt" } }));
        const { ctx, uiState, handlers } = makeExtension().install();
        let opened!: () => void;

        const opening = new Promise<void>((resolve) => {
          opened = resolve;
        });

        ctx.ui.select = async (_prompt, _options, settings) => {
          opened();
          const signal = settings?.signal;

          if (!signal) throw new Error("Expected a cancellation signal");
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );

          return "Allow";
        };

        const first = handlers.toolCall!(bashEvent("sudo echo first"), ctx);
        const second = handlers.toolCall!(bashEvent("sudo echo second"), ctx);
        await opening;
        handlers.sessionShutdown!();
        handlers.sessionShutdown!(); // Cleanup is idempotent.

        if (kind === "replacement") await handlers.sessionStart!({ reason: "switch" }, ctx);
        expect(await first).toMatchObject({ block: true, terminate: true });
        expect(await second).toMatchObject({ block: true, terminate: true });
        ctx.ui = createUi(uiState, true);
        uiState.selectResponse = "Allow";

        if (kind === "replacement")
          expect(await handlers.toolCall!(bashEvent("sudo echo fresh"), ctx)).toBeUndefined();
        else
          expect(await handlers.toolCall!(bashEvent("sudo echo stale"), ctx)).toMatchObject({
            block: true,
          });
        expect(uiState.selectCalls).toHaveLength(kind === "replacement" ? 1 : 0);
      },
    );

    it("does not poison queued approvals when a UI request fails", async () => {
      setConfig(JSON.stringify({ operations: { sudo: "prompt" } }));
      const { ctx, uiState, handlers } = makeExtension().install();
      uiState.onSelect = () => {
        throw new Error("UI unavailable");
      };

      await expect(handlers.toolCall!(bashEvent("sudo echo hi"), ctx)).rejects.toThrow(
        "UI unavailable",
      );
      uiState.onSelect = undefined;
      uiState.selectResponse = "Allow";
      expect(await handlers.toolCall!(bashEvent("sudo echo hi"), ctx)).toBeUndefined();
    });

    it("does not show an approval for an already-aborted turn", async () => {
      setConfig(JSON.stringify({ operations: { sudo: "prompt" } }));
      const { ctx, uiState, handlers } = makeExtension().install();
      ctx.signal = AbortSignal.abort();
      expect(await handlers.toolCall!(bashEvent("sudo echo hi"), ctx)).toMatchObject({
        block: true,
      });
      expect(uiState.selectCalls).toHaveLength(0);
    });

    it("prompts with the user and blocks on Deny", async () => {
      setConfig(JSON.stringify({ operations: { "rm -rf": "prompt" } }));
      const { ctx, uiState, handlers } = makeExtension().install();
      uiState.selectResponse = "Deny";
      const result = await handlers.toolCall!(bashEvent("rm -rf node_modules"), ctx);
      expect(result).toEqual({
        block: true,
        reason:
          'pi-gate: command not run because approval was denied. Ask the user before retrying (rule "rm -rf").',
        terminate: true,
      });
    });

    it("uses a separate denial reason when the configured prompt timeout expires", async () => {
      setConfig(JSON.stringify({ operations: { "rm -rf": "prompt" }, promptTimeoutMs: 20 }));
      const { ctx, uiState, handlers } = makeExtension().install();
      uiState.selectDelayMs = 30;
      const result = await handlers.toolCall!(bashEvent("rm -rf node_modules"), ctx);
      expect(uiState.selectCalls[0]?.settings).toEqual({
        timeout: 20,
        signal: expect.any(AbortSignal),
      });
      expect(result).toEqual({
        block: true,
        reason:
          'pi-gate: no response to rule "rm -rf" within 0.02s; command not run. Ask the user whether to retry approval.',
        terminate: true,
      });
    });

    it("keeps dismissal on the ordinary denial reason", async () => {
      setConfig(JSON.stringify({ operations: { "rm -rf": "prompt" }, promptTimeoutMs: 12_500 }));
      const { ctx, handlers } = makeExtension().install();
      const result = await handlers.toolCall!(bashEvent("rm -rf node_modules"), ctx);
      expect(result).toEqual({
        block: true,
        reason:
          'pi-gate: command not run because approval was denied. Ask the user before retrying (rule "rm -rf").',
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
          'pi-gate: rule "rm -rf" needs approval but no UI is available. Ask the user before proceeding.',
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
        reason:
          'pi-gate: command blocked by rule "sudo apt update". Ask the user before proceeding.',
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
        reason: 'pi-gate: command blocked by rule "sudo". Ask the user before proceeding.',
        terminate: true,
      });
    });
  });
});
