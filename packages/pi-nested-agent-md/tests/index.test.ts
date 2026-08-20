import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vite-plus/test";
import registerNestedAgents, { findNestedAgentsFiles } from "../src/index";

const temporaryDirectories = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((path) => rm(path, { recursive: true, force: true })),
  );
  temporaryDirectories.clear();
});

async function createTemporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.add(path);
  return path;
}

type EventHandler = (event: any, context: any) => object | undefined | Promise<object>;

interface HandlerMap {
  session_start: EventHandler;
  tool_result: EventHandler;
  session_compact: EventHandler;
  session_tree: EventHandler;
}

function registerHandlers(): HandlerMap {
  const handlers = new Map<string, EventHandler>();
  // SAFETY: registerNestedAgents only registers a fixed set of session/tool handlers via
  // `on`; we capture them in a map and replay them with explicit test inputs.
  registerNestedAgents({
    on(name: string, handler: EventHandler) {
      handlers.set(name, handler);
    },
  } as ExtensionAPI);
  return {
    session_start: handlers.get("session_start")!,
    tool_result: handlers.get("tool_result")!,
    session_compact: handlers.get("session_compact")!,
    session_tree: handlers.get("session_tree")!,
  };
}

async function createTree(): Promise<{
  root: string;
  target: string;
  outerAgents: string;
  innerAgents: string;
}> {
  const root = await createTemporaryDirectory("nested-agents-test-");
  const outer = join(root, "outer");
  const inner = join(outer, "inner");
  await mkdir(inner, { recursive: true });
  const outerAgents = join(outer, "AGENTS.md");
  const innerAgents = join(inner, "AGENTS.md");
  const target = join(inner, "file.ts");
  await writeFile(join(root, "AGENTS.md"), "root instructions", "utf8");
  await writeFile(outerAgents, "outer instructions", "utf8");
  await writeFile(innerAgents, "inner instructions", "utf8");
  await writeFile(target, "export {};", "utf8");
  return { root, target, outerAgents, innerAgents };
}

function readResult(path: string) {
  return {
    toolName: "read",
    toolCallId: "read-1",
    input: { path },
    content: [{ type: "text", text: "original file content" }],
    details: {},
    isError: false,
  };
}

describe("nested AGENTS.md discovery", () => {
  it("returns nested files from outermost to innermost and excludes the root file", async () => {
    const { root, target, outerAgents, innerAgents } = await createTree();
    await expect(findNestedAgentsFiles(root, target)).resolves.toEqual([outerAgents, innerAgents]);
  });

  it("rejects targets and symlinked instruction files outside the project", async () => {
    const { root, target, innerAgents } = await createTree();
    const outside = await createTemporaryDirectory("outside-agents-test-");
    const outsideTarget = join(outside, "outside.ts");
    const outsideAgents = join(outside, "AGENTS.md");
    await writeFile(outsideTarget, "outside", "utf8");
    await writeFile(outsideAgents, "outside instructions", "utf8");

    await expect(findNestedAgentsFiles(root, outsideTarget)).resolves.toEqual([]);

    await writeFile(innerAgents, "", "utf8");
    const linkedDirectory = join(root, "linked");
    await mkdir(linkedDirectory);
    const linkedTarget = join(linkedDirectory, "file.ts");
    await writeFile(linkedTarget, "target", "utf8");
    await symlink(outsideAgents, join(linkedDirectory, "AGENTS.md"));
    await expect(findNestedAgentsFiles(root, linkedTarget)).resolves.toEqual([]);
    await expect(findNestedAgentsFiles(root, target)).resolves.toHaveLength(2);
  });

  it("injects ordered instructions once and reinjects after compaction", async () => {
    const { root, target } = await createTree();
    const handlers = registerHandlers();
    const context = { cwd: root };
    await handlers.session_start({}, context);

    // SAFETY: handlers.tool_result returns the injected-instructions object built by the
    // extension; we assert it has the rendered `content` shape.
    const first = (await handlers.tool_result(readResult(target), context)) as {
      content: Array<{ type: string; text: string }>;
    };
    const appended = first.content.at(-1)?.text ?? "";
    expect(appended.indexOf("outer instructions")).toBeLessThan(
      appended.indexOf("inner instructions"),
    );
    expect(appended).not.toContain("root instructions");

    await expect(handlers.tool_result(readResult(target), context)).resolves.toBeUndefined();
    await handlers.session_compact({}, context);
    await expect(handlers.tool_result(readResult(target), context)).resolves.toBeDefined();
  });

  it("reinjects instructions after tree navigation", async () => {
    const { root, target } = await createTree();
    const handlers = registerHandlers();
    const context = { cwd: root };

    await expect(handlers.tool_result(readResult(target), context)).resolves.toBeDefined();
    await expect(handlers.tool_result(readResult(target), context)).resolves.toBeUndefined();
    await handlers.session_tree({}, context);
    await expect(handlers.tool_result(readResult(target), context)).resolves.toBeDefined();
  });

  it("does not append an AGENTS.md that was read directly", async () => {
    const { root, target, innerAgents } = await createTree();
    const handlers = registerHandlers();
    const context = { cwd: root };
    await handlers.session_start({}, context);

    // SAFETY: handlers.tool_result returns the injected-instructions object built by the
    // extension; we assert it has the rendered `content` shape.
    const directResult = (await handlers.tool_result(readResult(innerAgents), context)) as {
      content: Array<{ type: string; text: string }>;
    };
    const output = directResult.content.map((block) => block.text).join("\n");
    expect(output).toContain("outer instructions");
    expect(output).not.toContain("inner instructions");
    await expect(handlers.tool_result(readResult(target), context)).resolves.toBeUndefined();
  });

  it("escapes metacharacters and control characters in context paths", async () => {
    const root = await createTemporaryDirectory("nested-agents-path-test-");
    const scope = 'scope"<&\nname';
    const directory = join(root, scope);
    const target = join(directory, "file.ts");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "AGENTS.md"), "scoped instructions", "utf8");
    await writeFile(target, "export {};", "utf8");

    const handlers = registerHandlers();
    // SAFETY: handlers.tool_result returns the injected-instructions object built by the
    // extension; we assert it has the rendered `content` shape.
    const result = (await handlers.tool_result(readResult(target), { cwd: root })) as {
      content: Array<{ type: string; text: string }>;
    };
    const output = result.content.at(-1)?.text ?? "";

    expect(output).toContain(
      'path="scope&quot;&lt;&amp;�name/AGENTS.md" scope="scope&quot;&lt;&amp;�name"',
    );
    expect(output).toContain('files under scope"<&�name/.');
    expect(output).not.toContain('scope"<&\nname');
  });

  it("bounds injected instruction bytes and lines", async () => {
    const { root, target, innerAgents } = await createTree();
    await writeFile(innerAgents, `${"x".repeat(40_000)}\n${"line\n".repeat(3_000)}`, "utf8");
    const handlers = registerHandlers();
    const context = { cwd: root };
    await handlers.session_start({}, context);

    // SAFETY: handlers.tool_result returns the injected-instructions object built by the
    // extension; we assert it has the rendered `content` shape.
    const result = (await handlers.tool_result(readResult(target), context)) as {
      content: Array<{ type: string; text: string }>;
    };
    const output = result.content.map((block) => block.text).join("\n");
    expect(new TextEncoder().encode(output).byteLength).toBeLessThanOrEqual(50 * 1024);
    expect(output.split("\n").length).toBeLessThanOrEqual(2_000);
    expect(output).toContain("AGENTS.md truncated");
  });
});
