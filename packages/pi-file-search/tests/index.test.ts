import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";
import registerFileSearch, { containsFindInvocation, FILE_SEARCH_GUIDANCE } from "../src/index";

type BeforeAgentStartHandler = (event: {
  systemPrompt: string;
  systemPromptOptions: { selectedTools?: string[] };
}) => object | undefined;

type ToolCallHandler = (
  event: { toolName: string; input: { command: string } },
  ctx: {
    hasUI: boolean;
    ui: { confirm(title: string, message: string): Promise<boolean> };
  },
) => Promise<{ block: true; reason: string } | undefined>;

function registerHandlers(): {
  beforeAgentStart: BeforeAgentStartHandler;
  toolCall: ToolCallHandler;
} {
  let beforeAgentStart: BeforeAgentStartHandler | undefined;
  let toolCall: ToolCallHandler | undefined;
  registerFileSearch({
    on(name: string, handler: BeforeAgentStartHandler | ToolCallHandler) {
      if (name === "before_agent_start") {
        beforeAgentStart = handler as BeforeAgentStartHandler;
      } else if (name === "tool_call") {
        toolCall = handler as ToolCallHandler;
      }
    },
  } as unknown as ExtensionAPI);
  return { beforeAgentStart: beforeAgentStart!, toolCall: toolCall! };
}

const noUI = {
  hasUI: false,
  ui: { confirm: async () => false },
};

describe("file search guidance", () => {
  it("tells the agent to prefer fd when bash is active", () => {
    const result = registerHandlers().beforeAgentStart({
      systemPrompt: "base prompt",
      systemPromptOptions: { selectedTools: ["read", "bash"] },
    }) as { systemPrompt: string };

    expect(result.systemPrompt).toBe(`base prompt\n\n${FILE_SEARCH_GUIDANCE}`);
    expect(result.systemPrompt).toContain("Use `fd` for file and directory searches");
    expect(FILE_SEARCH_GUIDANCE).not.toContain("`find`");
    expect(FILE_SEARCH_GUIDANCE).not.toContain("fallback");
  });

  it("does not duplicate guidance already present in the system prompt", () => {
    const systemPrompt = `base prompt\n\n${FILE_SEARCH_GUIDANCE}`;

    expect(
      registerHandlers().beforeAgentStart({
        systemPrompt,
        systemPromptOptions: { selectedTools: ["bash"] },
      }),
    ).toBeUndefined();
  });

  it("does not add shell guidance when bash is inactive", () => {
    expect(
      registerHandlers().beforeAgentStart({
        systemPrompt: "base prompt",
        systemPromptOptions: { selectedTools: ["read"] },
      }),
    ).toBeUndefined();
  });
});

describe("find invocation detection", () => {
  it.each([
    "find . -name '*.ts'",
    "command find src",
    "sudo find /tmp",
    "/usr/bin/find .",
    "echo done && find .",
    "find \\\n      . -type f",
  ])("detects %j", (command) => {
    expect(containsFindInvocation(command)).toBe(true);
  });

  it.each(["fd .", "echo find .", "printf 'find .'"])("ignores %j", (command) => {
    expect(containsFindInvocation(command)).toBe(false);
  });
});

describe("find confirmation gate", () => {
  it("blocks find when UI is unavailable", async () => {
    expect(
      await registerHandlers().toolCall({ toolName: "bash", input: { command: "find src" } }, noUI),
    ).toEqual({
      block: true,
      reason: "find blocked without user confirmation. Use fd instead.",
    });
  });

  it("blocks find when the user declines", async () => {
    expect(
      await registerHandlers().toolCall(
        { toolName: "find", input: { command: "" } },
        { hasUI: true, ui: { confirm: async () => false } },
      ),
    ).toEqual({ block: true, reason: "find was not approved." });
  });

  it("allows find when the user approves", async () => {
    let prompt: [string, string] | undefined;
    const result = await registerHandlers().toolCall(
      { toolName: "bash", input: { command: "find src" } },
      {
        hasUI: true,
        ui: {
          confirm: async (title, message) => {
            prompt = [title, message];
            return true;
          },
        },
      },
    );

    expect(result).toBeUndefined();
    expect(prompt).toEqual(["Alternative file search", "Allow this command?\n\nfind src"]);
  });

  it("allows fd without requesting confirmation", async () => {
    let confirmationRequested = false;
    const result = await registerHandlers().toolCall(
      { toolName: "bash", input: { command: "fd . src" } },
      {
        hasUI: true,
        ui: {
          confirm: async () => {
            confirmationRequested = true;
            return false;
          },
        },
      },
    );

    expect(result).toBeUndefined();
    expect(confirmationRequested).toBe(false);
  });
});
