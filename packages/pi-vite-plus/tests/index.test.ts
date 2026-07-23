import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";
import registerVitePlus, { VITE_PLUS_GUIDANCE } from "../src/index";

type BeforeAgentStartHandler = (event: {
  systemPrompt: string;
  systemPromptOptions: { selectedTools?: string[] };
}) => object | undefined;

function registerHandler(): BeforeAgentStartHandler {
  let handler: BeforeAgentStartHandler | undefined;
  registerVitePlus({
    on(name: string, registeredHandler: BeforeAgentStartHandler) {
      if (name === "before_agent_start") handler = registeredHandler;
    },
  } as unknown as ExtensionAPI);
  return handler!;
}

describe("Vite+ guidance", () => {
  it("tells the agent to prefer vp when bash is active", () => {
    const result = registerHandler()({
      systemPrompt: "base prompt",
      systemPromptOptions: { selectedTools: ["read", "bash"] },
    }) as { systemPrompt: string };

    expect(result.systemPrompt).toBe(`base prompt\n\n${VITE_PLUS_GUIDANCE}`);
    expect(result.systemPrompt).toContain("Use `vp`");
    expect(result.systemPrompt).toContain("`vp help`");
    expect(result.systemPrompt).toContain("`node_modules/vite-plus/docs`");
  });

  it("does not duplicate guidance already present in the system prompt", () => {
    const systemPrompt = `base prompt\n\n${VITE_PLUS_GUIDANCE}`;

    expect(
      registerHandler()({
        systemPrompt,
        systemPromptOptions: { selectedTools: ["bash"] },
      }),
    ).toBeUndefined();
  });

  it("does not add command guidance when bash is inactive", () => {
    expect(
      registerHandler()({
        systemPrompt: "base prompt",
        systemPromptOptions: { selectedTools: ["read"] },
      }),
    ).toBeUndefined();
  });
});
