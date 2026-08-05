import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";
import registerCloudflare, { CLOUDFLARE_GUIDANCE } from "../src/index";

interface AgentStartEvent {
  systemPrompt: string;
  systemPromptOptions: { selectedTools?: string[] };
}

function registerExtension(): {
  eventNames: string[];
  beforeAgentStart: (event: AgentStartEvent) => { systemPrompt: string } | undefined;
} {
  const eventNames: string[] = [];
  let beforeAgentStart:
    | ((event: AgentStartEvent) => { systemPrompt: string } | undefined)
    | undefined;

  registerCloudflare({
    on(name: string, handler: (event: AgentStartEvent) => { systemPrompt: string } | undefined) {
      eventNames.push(name);
      if (name === "before_agent_start") beforeAgentStart = handler;
    },
  } as unknown as ExtensionAPI);

  if (!beforeAgentStart) throw new Error("before_agent_start handler was not registered");
  return { eventNames, beforeAgentStart };
}

describe("Cloudflare Workers guidance", () => {
  it("subscribes to before_agent_start", () => {
    expect(registerExtension().eventNames).toEqual(["before_agent_start"]);
  });

  it.each([
    ["bash only", ["bash"]],
    ["bash among other tools", ["read", "edit", "bash"]],
  ])("injects the guidance when bash is active: %s", (_label, selectedTools) => {
    const { beforeAgentStart } = registerExtension();
    expect(
      beforeAgentStart({ systemPrompt: "base prompt", systemPromptOptions: { selectedTools } }),
    ).toEqual({ systemPrompt: `base prompt\n\n${CLOUDFLARE_GUIDANCE}` });
  });

  it.each([
    ["no tool selection", undefined],
    ["no bash", ["read", "write"]],
    ["case mismatch", ["BASH"]],
  ])("stays quiet when bash is inactive: %s", (_label, selectedTools) => {
    const { beforeAgentStart } = registerExtension();
    expect(
      beforeAgentStart({ systemPrompt: "base prompt", systemPromptOptions: { selectedTools } }),
    ).toBeUndefined();
  });

  it("appends guidance without disturbing the existing system prompt", () => {
    const { beforeAgentStart } = registerExtension();
    const result = beforeAgentStart({
      systemPrompt: "existing\ninstructions",
      systemPromptOptions: { selectedTools: ["bash"] },
    });
    expect(result?.systemPrompt.startsWith("existing\ninstructions\n\n")).toBe(true);
    expect(result?.systemPrompt.endsWith(CLOUDFLARE_GUIDANCE)).toBe(true);
  });

  it("contains the create-cloudflare AGENTS.md guidance verbatim", () => {
    const fragments = [
      // docs and limits
      "Always retrieve current documentation",
      "https://developers.cloudflare.com/workers/",
      "MCP: `https://docs.mcp.cloudflare.com/mcp`",
      "`/workers/platform/limits`",
      "`npx wrangler dev`",
      "`npx wrangler deploy`",
      "`npx wrangler types`",
      "after changing bindings in wrangler.jsonc",
      "https://developers.cloudflare.com/workers/runtime-apis/nodejs/",
      "Error 1102",
      "https://developers.cloudflare.com/workers/observability/errors/",
      // product index
      "/kv/",
      "/r2/",
      "/d1/",
      "/durable-objects/",
      "/queues/",
      "/vectorize/",
      "/workers-ai/",
      "/agents/",
      // best practices
      "rules-of-durable-objects",
      "rules-of-workflows",
    ];
    for (const fragment of fragments) {
      expect(CLOUDFLARE_GUIDANCE).toContain(fragment);
    }
  });
});
