import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { expect, it } from "vite-plus/test";
import piGate from "../src/index";

it("gates real SDK nested calls without a model request or shell execution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-gate-nested-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  let toolContext: ExtensionToolContext | undefined;
  const calls: string[] = [];
  const events: Array<{ toolName: string; parentToolCallId?: string }> = [];
  const settingsManager = SettingsManager.inMemory();

  const resourceLoader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      piGate,
      (pi) => {
        pi.on("tool_call", (event) => {
          events.push(event);
        });
        // Replace bash with an inert recorder; exercise Pi's hooks, never a shell.
        pi.registerTool({
          name: "bash",
          label: "Bash fixture",
          description: "Test fixture",
          parameters: Type.Object({ command: Type.String() }),
          async execute(_id, params) {
            calls.push(params.command);

            return { content: [{ type: "text", text: "recorded" }], details: undefined };
          },
        });
        pi.registerTool({
          name: "nested_probe",
          label: "Nested probe",
          description: "Test fixture",
          parameters: Type.Object({}),
          async execute(_id, _params, _signal, _update, ctx) {
            toolContext = ctx;

            return { content: [], details: undefined };
          },
        });
      },
    ],
  });

  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;

  try {
    await writeFile(
      join(directory, "gate.json"),
      JSON.stringify({ operations: { forbidden: "block", approval: "prompt" } }),
    );
    await resourceLoader.reload();
    // Seed a finalized assistant call, as a model response would, without network access.
    const sessionManager = SessionManager.inMemory(directory);
    sessionManager.appendMessage({
      role: "assistant",
      api: "openai-completions",
      provider: "fixture",
      model: "fixture",
      content: [{ type: "toolCall", id: "parent", name: "nested_probe", arguments: {} }],
      stopReason: "toolUse",
      timestamp: Date.now(),
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    ({ session } = await createAgentSession({
      cwd: directory,
      agentDir: directory,
      resourceLoader,
      settingsManager,
      sessionManager,
      tools: ["bash", "nested_probe"],
    }));
    await session.bindExtensions({ mode: "print" });
    const probe = session.agent.state.tools.find((tool) => tool.name === "nested_probe");
    expect(probe).toBeDefined();
    await probe!.execute("parent", {}, undefined);
    expect(toolContext).toBeDefined();
    const ctx = toolContext!;

    const results = await Promise.all([
      ctx.executeTool("bash", { command: "forbidden" }),
      ctx.executeTool("bash", { command: "approval" }),
      ctx.executeTool("bash", { command: "safe" }),
    ]);

    expect(results.map((result) => result.isError)).toEqual([true, true, false]);
    expect(results[0]?.result.content).toEqual([
      { type: "text", text: expect.stringContaining("blocked by rule") },
    ]);
    expect(results[1]?.result.content).toEqual([
      { type: "text", text: expect.stringContaining("no UI") },
    ]);
    expect(calls).toEqual(["safe"]);
    expect(events).toContainEqual(
      expect.objectContaining({ toolName: "bash", parentToolCallId: "parent" }),
    );
    await expect(
      ctx.executeTool("bash", { command: "safe" }, { signal: AbortSignal.abort() }),
    ).resolves.toMatchObject({ isError: true });
    expect(calls).toEqual(["safe"]);
  } finally {
    session?.dispose();

    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
