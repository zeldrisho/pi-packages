import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";
import registerVitePlus, { VITE_PLUS_GUIDANCE } from "../src/index";

type BeforeAgentStartHandler = (event: {
  systemPrompt: string;
  systemPromptOptions: { selectedTools?: string[] };
}) => { systemPrompt: string } | undefined;

function registerExtension(): { events: string[]; handler: BeforeAgentStartHandler } {
  const events: string[] = [];
  let handler: BeforeAgentStartHandler | undefined;

  registerVitePlus({
    on(name: string, registeredHandler: BeforeAgentStartHandler) {
      events.push(name);
      if (name === "before_agent_start") handler = registeredHandler;
    },
  } as unknown as ExtensionAPI);

  if (!handler) throw new Error("before_agent_start handler was not registered");
  return { events, handler };
}

describe("Vite+ guidance", () => {
  it("registers prompt guidance without a tool-call gate", () => {
    expect(registerExtension().events).toEqual(["before_agent_start"]);
  });

  it.each([
    ["bash only", ["bash"]],
    ["bash first", ["bash", "read", "edit"]],
    ["bash last", ["read", "write", "bash"]],
  ])("adds guidance when bash is active: %s", (_label, selectedTools) => {
    expect(
      registerExtension().handler({
        systemPrompt: "base prompt",
        systemPromptOptions: { selectedTools },
      }),
    ).toEqual({ systemPrompt: `base prompt\n\n${VITE_PLUS_GUIDANCE}` });
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

  it.each(["", "line one\nline two", "prompt with unicode: 検証"])(
    "preserves the existing prompt before appending guidance: %j",
    (systemPrompt) => {
      expect(
        registerExtension().handler({
          systemPrompt,
          systemPromptOptions: { selectedTools: ["bash"] },
        }),
      ).toEqual({ systemPrompt: `${systemPrompt}\n\n${VITE_PLUS_GUIDANCE}` });
    },
  );

  it.each([
    "<!--VITE PLUS START-->",
    "# Using Vite+, the Unified Toolchain for the Web",
    "a single global CLI called `vp`",
    "Vite+ is distinct from Vite",
    "`vp dev` and `vp build`",
    "`vp help`",
    "`vp <command> --help`",
    "`node_modules/vite-plus/docs`",
    "https://viteplus.dev/guide/",
    "## Review Checklist",
    "`vp install` after pulling remote changes",
    "`vp check` and `vp test`",
    "`vp run <script>`",
    "`vp env doctor`",
    "<!--VITE PLUS END-->",
  ])("includes the complete instruction: %s", (instruction) => {
    expect(VITE_PLUS_GUIDANCE).toContain(instruction);
  });
});
