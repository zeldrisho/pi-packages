import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";
import registerFileSearch, { FILE_SEARCH_GUIDANCE } from "../src/index";

type BeforeAgentStartHandler = (event: {
  systemPrompt: string;
  systemPromptOptions: { selectedTools?: string[] };
}) => object | undefined;

function registerHandler(): BeforeAgentStartHandler {
  let handler: BeforeAgentStartHandler | undefined;
  registerFileSearch({
    on(name: string, registeredHandler: BeforeAgentStartHandler) {
      if (name === "before_agent_start") handler = registeredHandler;
    },
  } as unknown as ExtensionAPI);
  return handler!;
}

describe("file search guidance", () => {
  it("tells the agent to prefer fd when bash is active", () => {
    const result = registerHandler()({
      systemPrompt: "base prompt",
      systemPromptOptions: { selectedTools: ["read", "bash"] },
    }) as { systemPrompt: string };

    expect(result.systemPrompt).toBe(`base prompt\n\n${FILE_SEARCH_GUIDANCE}`);
    expect(result.systemPrompt).toContain("Use `fd` via `bash`");
    expect(FILE_SEARCH_GUIDANCE).not.toContain("`find`");
    expect(FILE_SEARCH_GUIDANCE).not.toContain("fallback");
  });

  it("does not duplicate guidance already present in the system prompt", () => {
    const systemPrompt = `base prompt\n\n${FILE_SEARCH_GUIDANCE}`;

    expect(
      registerHandler()({
        systemPrompt,
        systemPromptOptions: { selectedTools: ["bash"] },
      }),
    ).toBeUndefined();
  });

  it("does not add shell guidance when bash is inactive", () => {
    expect(
      registerHandler()({
        systemPrompt: "base prompt",
        systemPromptOptions: { selectedTools: ["read"] },
      }),
    ).toBeUndefined();
  });
});
