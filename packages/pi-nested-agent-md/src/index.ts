import { readFile } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isReadToolResult } from "@earendil-works/pi-coding-agent";
import { ContextAccumulator } from "./context";
import { AGENTS_FILE, findNestedAgentsFiles, resolveContainedTarget } from "./discovery";

export { findNestedAgentsFiles } from "./discovery";

export default function nestedAgents(pi: ExtensionAPI): void {
  const injected = new Set<string>();

  pi.on("session_start", () => {
    injected.clear();
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.isError || !isReadToolResult(event)) return;
    // SAFETY: a read tool result always carries a string `path`; isReadToolResult already
    // confirmed the tool, so after the null check we treat it as the path string.
    const inputPath = event.input.path == null ? undefined : (event.input.path as string);
    if (!inputPath || !event.content.some((block) => block.type === "text")) return;

    // A successful direct read already put this file's instructions in context.
    // Reserve it before awaiting so a concurrent sibling read cannot append it again.
    const requestedPath = isAbsolute(inputPath) ? inputPath : resolve(ctx.cwd, inputPath);
    if (basename(requestedPath) === AGENTS_FILE) {
      injected.add(requestedPath);
      const contained = await resolveContainedTarget(ctx.cwd, inputPath);
      if (contained) injected.add(contained.target);
    }

    const paths = (await findNestedAgentsFiles(ctx.cwd, inputPath)).filter(
      (path) => !injected.has(path),
    );
    if (paths.length === 0) return;

    const context = new ContextAccumulator(event.content);
    for (const path of paths) {
      if (injected.has(path)) continue;
      if (!context.hasCapacity(ctx.cwd, path)) break;

      // Reserve before awaiting so concurrent read results cannot inject the same file.
      injected.add(path);
      let fileContent: string;
      try {
        fileContent = await readFile(path, "utf8");
      } catch {
        injected.delete(path);
        continue;
      }

      if (!context.append(ctx.cwd, path, fileContent)) {
        injected.delete(path);
        break;
      }
    }

    if (!context.text) return;
    return { content: [...event.content, { type: "text" as const, text: context.text }] };
  });

  pi.on("session_compact", () => {
    injected.clear();
  });

  pi.on("session_tree", () => {
    injected.clear();
  });

  pi.on("session_shutdown", () => {
    injected.clear();
  });
}
