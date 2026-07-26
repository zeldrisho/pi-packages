import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";
import registerFileSearch, { FILE_SEARCH_GUIDANCE } from "../src/index";

type BeforeAgentStartHandler = (event: {
  systemPrompt: string;
  systemPromptOptions: { selectedTools?: string[] };
}) => { systemPrompt: string } | undefined;

function registerExtension(): { events: string[]; handler: BeforeAgentStartHandler } {
  const events: string[] = [];
  let handler: BeforeAgentStartHandler | undefined;

  registerFileSearch({
    on(name: string, registeredHandler: BeforeAgentStartHandler) {
      events.push(name);
      if (name === "before_agent_start") handler = registeredHandler;
    },
  } as unknown as ExtensionAPI);

  if (!handler) throw new Error("before_agent_start handler was not registered");
  return { events, handler };
}

describe("file search guidance", () => {
  it("registers prompt guidance without a tool-call gate", () => {
    expect(registerExtension().events).toEqual(["before_agent_start"]);
  });

  it.each([
    ["bash only", ["bash"]],
    ["bash first", ["bash", "read", "edit"]],
    ["bash last", ["read", "write", "bash"]],
  ])("adds guidance when bash is active: %s", (_label, selectedTools) => {
    const result = registerExtension().handler({
      systemPrompt: "base prompt",
      systemPromptOptions: { selectedTools },
    });

    expect(result).toEqual({ systemPrompt: `base prompt\n\n${FILE_SEARCH_GUIDANCE}` });
  });

  it.each([
    ["missing selection", undefined],
    ["empty selection", []],
    ["other tools", ["read", "edit"]],
    ["case mismatch", ["BASH"]],
  ])("does not add guidance when bash is inactive: %s", (_label, selectedTools) => {
    expect(
      registerExtension().handler({
        systemPrompt: "base prompt",
        systemPromptOptions: { selectedTools },
      }),
    ).toBeUndefined();
  });

  it.each(["", "line one\nline two", "prompt with unicode: 検索"])(
    "preserves the existing prompt before appending guidance: %j",
    (systemPrompt) => {
      expect(
        registerExtension().handler({
          systemPrompt,
          systemPromptOptions: { selectedTools: ["bash"] },
        }),
      ).toEqual({ systemPrompt: `${systemPrompt}\n\n${FILE_SEARCH_GUIDANCE}` });
    },
  );

  it("concisely prefers fd over find", () => {
    expect(FILE_SEARCH_GUIDANCE).toBe("## File search\n\n- Use `fd` instead of `find` by default.");
  });
});
