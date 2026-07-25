import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";
import registerVitePlus, {
  containsPackageManagerInvocation,
  VITE_PLUS_GUIDANCE,
} from "../src/index";

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
  registerVitePlus({
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

describe("Vite+ guidance", () => {
  it("tells the agent to prefer vp when bash is active", () => {
    const result = registerHandlers().beforeAgentStart({
      systemPrompt: "base prompt",
      systemPromptOptions: { selectedTools: ["read", "bash"] },
    }) as { systemPrompt: string };

    expect(result.systemPrompt).toBe(`base prompt\n\n${VITE_PLUS_GUIDANCE}`);
    expect(result.systemPrompt).toContain(
      "Use `vp` for package management and development workflows",
    );
  });

  it("does not duplicate guidance already present in the system prompt", () => {
    const systemPrompt = `base prompt\n\n${VITE_PLUS_GUIDANCE}`;

    expect(
      registerHandlers().beforeAgentStart({
        systemPrompt,
        systemPromptOptions: { selectedTools: ["bash"] },
      }),
    ).toBeUndefined();
  });

  it("does not add command guidance when bash is inactive", () => {
    expect(
      registerHandlers().beforeAgentStart({
        systemPrompt: "base prompt",
        systemPromptOptions: { selectedTools: ["read"] },
      }),
    ).toBeUndefined();
  });
});

describe("package-manager invocation detection", () => {
  it.each([
    "npm install",
    "npx vitest",
    "pnpm test",
    "pnpx vite",
    "bun test",
    "bunx vite",
    "command npm test",
    "sudo pnpm install",
    "echo done && bun test",
    "npm \\\n      test",
  ])("detects %j", (command) => {
    expect(containsPackageManagerInvocation(command)).toBe(true);
  });

  it.each([
    "vp install",
    "vp test",
    "vp exec vitest",
    "vp env exec --node lts npm i",
    "yarn test",
    "yarnpkg lint",
    "vite build",
    "vitest run",
    "/usr/local/bin/vitest run",
    "tsdown",
    "oxlint src",
    "oxfmt .",
    "git test",
  ])("ignores %j", (command) => {
    expect(containsPackageManagerInvocation(command)).toBe(false);
  });
});

describe("package-manager confirmation gate", () => {
  it("blocks matching commands when UI is unavailable", async () => {
    expect(
      await registerHandlers().toolCall(
        { toolName: "bash", input: { command: "pnpm test" } },
        noUI,
      ),
    ).toEqual({
      block: true,
      reason: "Package-manager command blocked without user confirmation. Use vp instead.",
    });
  });

  it("blocks matching commands when the user declines", async () => {
    expect(
      await registerHandlers().toolCall(
        { toolName: "bash", input: { command: "npm install" } },
        { hasUI: true, ui: { confirm: async () => false } },
      ),
    ).toEqual({ block: true, reason: "Package-manager command was not approved." });
  });

  it("allows matching commands when the user approves", async () => {
    let prompt: [string, string] | undefined;
    const result = await registerHandlers().toolCall(
      { toolName: "bash", input: { command: "bun test" } },
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
    expect(prompt).toEqual(["Direct package-manager command", "Allow this command?\n\nbun test"]);
  });

  it("allows vp without requesting confirmation", async () => {
    let confirmationRequested = false;
    const result = await registerHandlers().toolCall(
      { toolName: "bash", input: { command: "vp test" } },
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
