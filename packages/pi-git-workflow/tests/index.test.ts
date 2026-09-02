// oxlint-disable anti-slop/no-chained-type-assertions, typescript/unbound-method, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unknown-parameters
import { describe, expect, it, vi } from "vite-plus/test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  cleanupRepository,
  formatCleanupContext,
  formatSyncContext,
  parseLocalBranches,
  parseWorktreeBranches,
  withRepoQueue,
} from "../src/cleanup";
import piGitWorkflow, { extractBranchName } from "../src/index";
import {
  detectTargetBranchInRepo,
  git,
  GitInspectionError,
  requireBoundedOutput,
  sanitizeGitOutput,
} from "../src/git";

const root = process.cwd();
const mainCommit = "a".repeat(40);
const branchCommit = "b".repeat(40);

function branchRecord(
  name: string,
  commit = branchCommit,
  upstream = `refs/remotes/origin/${name}`,
  tracking = "[gone]",
): string {
  return `refs/heads/${name}\0${commit}\0${upstream}\0${tracking}\0\n`;
}

function cleanupPi(
  branchOutput: string,
  overrides: (args: string[], call: number) => Partial<ExecResult> | undefined = () => undefined,
) {
  const calls: string[][] = [];
  const exec = vi.fn(async (_command: string, args: string[]) => {
    calls.push(args);
    const override = overrides(args, calls.length);
    if (override) return result(override);
    const key = args.join(" ");
    if (key === "rev-parse --is-inside-work-tree") return result({ stdout: "true\n" });
    if (key === "rev-parse --is-bare-repository") return result({ stdout: "false\n" });
    if (key === "rev-parse --show-toplevel") return result({ stdout: `${root}\n` });
    if (key === "fetch --prune origin") return result();
    if (key === "symbolic-ref refs/remotes/origin/HEAD")
      return result({ stdout: "refs/remotes/origin/main\n" });
    if (key === "rev-parse --verify refs/remotes/origin/main^{commit}")
      return result({ stdout: `${mainCommit}\n` });
    if (key === "branch --show-current") return result({ stdout: "main\n" });
    if (args[0] === "for-each-ref") return result({ stdout: branchOutput });
    if (key === "worktree list --porcelain")
      return result({ stdout: `worktree ${root}\nHEAD ${mainCommit}\nbranch refs/heads/main\n\n` });
    if (args[0] === "merge-base") return result();
    if (key === "rev-parse --verify refs/heads/feature^{commit}")
      return result({ stdout: `${branchCommit}\n` });
    if (key === "branch --delete -- feature") return result();
    return result({ code: 1, stderr: `unexpected: ${key}` });
  });
  return { pi: { exec } as unknown as Pick<ExtensionAPI, "exec">, calls };
}

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  killed: boolean;
}

function result(partial: Partial<ExecResult> = {}): ExecResult {
  return { code: 0, stdout: "", stderr: "", killed: false, ...partial };
}

describe("Git inspection helpers", () => {
  it("uses bounded target fallbacks and rejects detached fallback", async () => {
    function targetPi(available: "main" | "master" | "current" | "detached") {
      return {
        exec: vi.fn(async (_command: string, args: string[]) => {
          if (args[0] === "symbolic-ref") return result({ code: 1 });
          if (args[0] === "show-ref") {
            const name = args.at(-1)?.split("/").at(-1);
            return result({ code: name === available ? 0 : 1 });
          }
          if (args[0] === "branch")
            return result({ stdout: available === "detached" ? "" : "develop\n" });
          return result({ code: 1 });
        }),
      } as unknown as Pick<ExtensionAPI, "exec">;
    }
    await expect(detectTargetBranchInRepo(targetPi("main"), root)).resolves.toBe("main");
    await expect(detectTargetBranchInRepo(targetPi("master"), root)).resolves.toBe("master");
    await expect(detectTargetBranchInRepo(targetPi("current"), root)).resolves.toBe("develop");
    await expect(detectTargetBranchInRepo(targetPi("detached"), root)).rejects.toMatchObject({
      code: "detached_head",
    });
  });

  it("sanitizes control output and enforces the output bound", () => {
    expect(sanitizeGitOutput("bad\u001b\n message", 20)).toBe("bad message");
    expect(() =>
      requireBoundedOutput(result({ stdout: "x".repeat(1_000_001) }), "inspection"),
    ).toThrow(/too much data/);
  });

  it("fails closed when a Git command is killed", () => {
    expect(() => requireBoundedOutput(result({ killed: true }), "branch inspection")).toThrow(
      /killed or timed out/,
    );
  });

  it("wraps a timed-out Git command as an inspection failure", async () => {
    const pi = {
      exec: vi.fn(async () => {
        throw new Error("Command timed out after 30000ms");
      }),
    } as unknown as Pick<ExtensionAPI, "exec">;
    await expect(git(pi, root, ["status"])).rejects.toMatchObject({
      code: "git_command_failed",
      details: "Command timed out after 30000ms",
    });
  });
});

describe("machine-readable parsing", () => {
  it("parses branches and tracking state", () => {
    const branches = parseLocalBranches(
      branchRecord("feature") + branchRecord("local", branchCommit, "", ""),
    );
    expect(branches).toMatchObject([
      { name: "feature", upstream: "refs/remotes/origin/feature", tracking: "[gone]" },
      { name: "local", upstream: undefined },
    ]);
  });

  it("rejects malformed and oversized branch output", () => {
    expect(() => parseLocalBranches("not-machine-readable\n")).toThrow(GitInspectionError);
    expect(() => parseLocalBranches("x".repeat(1_000_001))).toThrow(/too much data/);
  });

  it("parses branches occupied by linked worktrees and rejects uncertain output", () => {
    expect(
      parseWorktreeBranches(
        "worktree /one\nHEAD abc\nbranch refs/heads/main\n\nworktree /two\nHEAD def\nbranch refs/heads/feature\n",
      ),
    ).toEqual(new Set(["main", "feature"]));
    expect(() => parseWorktreeBranches("worktree /one\nunknown field\n")).toThrow(/malformed/);
    expect(() => parseWorktreeBranches("worktree /truncated")).toThrow(/incomplete/);
  });
});

describe("cleanupRepository", () => {
  it("fetches first and deletes only with exact non-force argv", async () => {
    const { pi, calls } = cleanupPi(
      branchRecord("main", mainCommit, "refs/remotes/origin/main", "") + branchRecord("feature"),
    );
    const cleanup = await cleanupRepository(pi, { cwd: root, trusted: true });
    expect(cleanup.deleted).toEqual(["feature"]);
    expect(calls).toContainEqual(["branch", "--delete", "--", "feature"]);
    expect(calls.flat()).not.toContain("--force");
    expect(calls.findIndex((args) => args[0] === "fetch")).toBeLessThan(
      calls.findIndex((args) => args[0] === "symbolic-ref"),
    );
  });

  it("reports when the current branch is behind its fetched upstream", async () => {
    const { pi } = cleanupPi(
      branchRecord("main", branchCommit, "refs/remotes/origin/main", "[behind 1]"),
    );
    const cleanup = await cleanupRepository(pi, { cwd: root, trusted: true });
    expect(cleanup.sync).toEqual({
      branch: "main",
      upstream: "refs/remotes/origin/main",
      state: "behind",
    });
    expect(formatSyncContext(cleanup.sync)).toContain("Before modifying files");
  });

  it("reports a diverged current branch without choosing an integration strategy", async () => {
    const { pi } = cleanupPi(
      branchRecord("main", branchCommit, "refs/remotes/origin/main", "[ahead 1, behind 1]"),
      (args) => (args[0] === "merge-base" ? { code: 1 } : undefined),
    );
    const cleanup = await cleanupRepository(pi, { cwd: root, trusted: true });
    expect(cleanup.sync.state).toBe("diverged");
    expect(formatSyncContext(cleanup.sync)).toContain("Do not automatically merge, rebase, reset");
  });

  it("retains no-upstream and unmerged upstream-gone branches for review", async () => {
    const output =
      branchRecord("main", mainCommit, "refs/remotes/origin/main", "") +
      branchRecord("local", branchCommit, "", "") +
      branchRecord("feature");
    const { pi } = cleanupPi(output, (args) =>
      args[0] === "merge-base" ? { code: 1 } : undefined,
    );
    const cleanup = await cleanupRepository(pi, { cwd: root, trusted: true });
    expect(cleanup.deleted).toEqual([]);
    expect(cleanup.review.map((item) => item.name)).toEqual(["local", "feature"]);
  });

  it("retains branches checked out in another worktree", async () => {
    const { pi } = cleanupPi(branchRecord("feature"), (args) =>
      args[0] === "worktree"
        ? { stdout: "worktree /other\nbranch refs/heads/feature\n" }
        : undefined,
    );
    const cleanup = await cleanupRepository(pi, { cwd: root, trusted: true });
    expect(cleanup.review[0]?.reason).toContain("linked worktree");
  });

  it("retains a branch whose upstream still exists", async () => {
    const { pi, calls } = cleanupPi(
      branchRecord("feature", branchCommit, "refs/remotes/origin/feature", ""),
    );
    const cleanup = await cleanupRepository(pi, { cwd: root, trusted: true });
    expect(cleanup.retained).toContain("feature");
    expect(calls.some((args) => args[0] === "branch" && args[1] === "--delete")).toBe(false);
  });

  it("reverifies refs and retains a concurrently moved branch", async () => {
    const moved = "c".repeat(40);
    const { pi, calls } = cleanupPi(branchRecord("feature"), (args) =>
      args.join(" ") === "rev-parse --verify refs/heads/feature^{commit}"
        ? { stdout: `${moved}\n` }
        : undefined,
    );
    const cleanup = await cleanupRepository(pi, { cwd: root, trusted: true });
    expect(cleanup.review[0]?.reason).toContain("moved");
    expect(calls.some((args) => args[0] === "branch" && args[1] === "--delete")).toBe(false);
  });

  it("retains a candidate ref that disappears before deletion", async () => {
    const { pi, calls } = cleanupPi(branchRecord("feature"), (args) =>
      args.join(" ") === "rev-parse --verify refs/heads/feature^{commit}" ? { code: 1 } : undefined,
    );
    const cleanup = await cleanupRepository(pi, { cwd: root, trusted: true });
    expect(cleanup.review[0]?.reason).toContain("disappeared");
    expect(calls.some((args) => args[0] === "branch" && args[1] === "--delete")).toBe(false);
  });

  it("retains a branch when Git or a hook rejects deletion", async () => {
    const { pi } = cleanupPi(branchRecord("feature"), (args) =>
      args[0] === "branch" && args[1] === "--delete"
        ? { code: 1, stderr: "hook rejected\nsecond line" }
        : undefined,
    );
    const cleanup = await cleanupRepository(pi, { cwd: root, trusted: true });
    expect(cleanup.review[0]?.reason).toContain("hook rejected second line");
  });

  it("rejects untrusted projects before running Git", async () => {
    const { pi } = cleanupPi("");
    await expect(cleanupRepository(pi, { cwd: root, trusted: false })).rejects.toMatchObject({
      code: "untrusted_project",
    });
    expect(pi.exec).not.toHaveBeenCalled();
  });

  it("rejects non-worktree and bare repositories", async () => {
    const outside = {
      exec: vi.fn(async () => result({ code: 128, stderr: "not a repository" })),
    } as unknown as Pick<ExtensionAPI, "exec">;
    await expect(cleanupRepository(outside, { cwd: root, trusted: true })).rejects.toMatchObject({
      code: "not_git_worktree",
    });

    const bare = {
      exec: vi.fn(async (_command: string, args: string[]) =>
        result({ stdout: args.includes("--is-inside-work-tree") ? "true\n" : "true\n" }),
      ),
    } as unknown as Pick<ExtensionAPI, "exec">;
    await expect(cleanupRepository(bare, { cwd: root, trusted: true })).rejects.toMatchObject({
      code: "bare_repository",
    });
  });

  it("serializes work for the same canonical root", async () => {
    const order: string[] = [];
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = withRepoQueue(root, async () => {
      order.push("first-start");
      await wait;
      order.push("first-end");
    });
    const second = withRepoQueue(root, async () => {
      order.push("second");
    });
    await vi.waitFor(() => expect(order).toEqual(["first-start"]));
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });
});

describe("bounded review context", () => {
  it("sanitizes untrusted names, bounds output, and includes safety instruction", () => {
    const review = Array.from({ length: 100 }, (_, index) => ({
      name: `evil\n\`branch-${index}`,
      commit: branchCommit,
      reason: "reason\u001b[31m".repeat(100),
    }));
    const context = formatCleanupContext(review)!;
    expect(Buffer.byteLength(context)).toBeLessThanOrEqual(6_000);
    expect(context).not.toContain("evil\n");
    expect(context).toContain("Do not force-delete");
  });
});

describe("extension registration and gate", () => {
  function captureHandlers(pi: Pick<ExtensionAPI, "exec">) {
    const handlers = new Map<string, (event: any, ctx: any) => Promise<any>>();
    const extension = pi as ExtensionAPI;
    extension.on = vi.fn((name: string, handler: (event: any, ctx: any) => Promise<any>) => {
      handlers.set(name, handler);
    }) as any;
    piGitWorkflow(extension);
    return handlers;
  }

  it("registers no command or agent-callable tool", () => {
    const pi = {
      on: vi.fn(),
      registerCommand: vi.fn(),
      registerTool: vi.fn(),
    } as unknown as ExtensionAPI;
    piGitWorkflow(pi);
    expect(pi.registerCommand).not.toHaveBeenCalled();
    expect(pi.registerTool).not.toHaveBeenCalled();
  });

  it("extracts deletion names and blocks force deletion without Git", async () => {
    expect(extractBranchName("git branch --delete -- feature")).toBe("feature");
    let handler!: (event: any, ctx: any) => Promise<any>;
    const pi = {
      on: vi.fn((name: string, value: typeof handler) => {
        if (name === "tool_call") handler = value;
      }),
      exec: vi.fn(),
    } as unknown as ExtensionAPI;
    piGitWorkflow(pi);
    const blocked = await handler(
      { toolName: "bash", input: { command: "git branch -D feature" } },
      { cwd: root, isProjectTrusted: () => true },
    );
    expect(blocked.block).toBe(true);
    expect(pi.exec).not.toHaveBeenCalled();
    const combined = await handler(
      { toolName: "bash", input: { command: "git branch -df feature" } },
      { cwd: root, isProjectTrusted: () => true },
    );
    expect(combined.block).toBe(true);
  });

  it("allows ordinary deletion only when refreshed exact refs are merged and upstream-gone", async () => {
    const { pi } = cleanupPi(branchRecord("feature"));
    const tool = captureHandlers(pi).get("tool_call")!;
    const context = { cwd: root, isProjectTrusted: () => true };
    expect(
      await tool({ toolName: "bash", input: { command: "git branch -d feature" } }, context),
    ).toBeUndefined();

    const unmerged = cleanupPi(branchRecord("feature"), (args) =>
      args[0] === "merge-base" ? { code: 1 } : undefined,
    );
    const unmergedResult = await captureHandlers(unmerged.pi).get("tool_call")!(
      { toolName: "bash", input: { command: "git branch -d feature" } },
      context,
    );
    expect(unmergedResult.block).toBe(true);

    const tracked = cleanupPi(
      branchRecord("feature", branchCommit, "refs/remotes/origin/feature", ""),
    );
    const trackedResult = await captureHandlers(tracked.pi).get("tool_call")!(
      { toolName: "bash", input: { command: "git branch --delete feature" } },
      context,
    );
    expect(trackedResult.reason).toContain("not confirmed gone");
  });

  it("fails closed for untrusted projects and failed refreshed inspection", async () => {
    const { pi } = cleanupPi(branchRecord("feature"), (args) =>
      args[0] === "fetch" ? { code: 1, stderr: "offline" } : undefined,
    );
    const tool = captureHandlers(pi).get("tool_call")!;
    const event = { toolName: "bash", input: { command: "git branch -d feature" } };
    expect((await tool(event, { cwd: root, isProjectTrusted: () => false })).reason).toContain(
      "not trusted",
    );
    expect((await tool(event, { cwd: root, isProjectTrusted: () => true })).reason).toContain(
      "offline",
    );
    expect(await tool({ toolName: "read", input: {} }, {})).toBeUndefined();
    expect(await tool({ toolName: "bash", input: { command: "git status" } }, {})).toBeUndefined();
  });

  it("deduplicates visible review notices and never reloads", async () => {
    const { pi } = cleanupPi(branchRecord("feature"), (args) =>
      args[0] === "merge-base" ? { code: 1 } : undefined,
    );
    const before = captureHandlers(pi).get("before_agent_start")!;
    const notify = vi.fn();
    const reload = vi.fn();
    const ctx = {
      cwd: root,
      hasUI: true,
      isProjectTrusted: () => true,
      ui: { notify },
      reload,
    };
    const first = await before({}, ctx);
    const second = await before({}, ctx);
    expect(first.message.content).toContain("feature");
    expect(second.message.content).toContain("feature");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
  });

  it("injects and deduplicates a warning when the current branch needs synchronization", async () => {
    const { pi } = cleanupPi(
      branchRecord("main", branchCommit, "refs/remotes/origin/main", "[behind 1]"),
    );
    const before = captureHandlers(pi).get("before_agent_start")!;
    const notify = vi.fn();
    const ctx = {
      cwd: root,
      hasUI: true,
      isProjectTrusted: () => true,
      ui: { notify },
    };
    const first = await before({}, ctx);
    const second = await before({}, ctx);
    expect(first.message.content).toContain(
      "synchronize using an explicit, user-approved strategy",
    );
    expect(second.message.content).toContain(
      "synchronize using an explicit, user-approved strategy",
    );
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("returns no hidden context when cleanup has no review candidates", async () => {
    const { pi } = cleanupPi(branchRecord("main", mainCommit, "refs/remotes/origin/main", ""));
    const before = captureHandlers(pi).get("before_agent_start")!;
    const result = await before(
      {},
      {
        cwd: root,
        hasUI: false,
        isProjectTrusted: () => true,
        ui: { notify: vi.fn() },
      },
    );
    expect(result).toBeUndefined();
  });

  it("reports bounded inspection failures but skips non-repositories", async () => {
    const failed = cleanupPi("", (args) =>
      args[0] === "fetch" ? { code: 1, stderr: "network\nerror" } : undefined,
    );
    const before = captureHandlers(failed.pi).get("before_agent_start")!;
    const notify = vi.fn();
    const result = await before(
      {},
      {
        cwd: root,
        hasUI: true,
        isProjectTrusted: () => true,
        ui: { notify },
      },
    );
    expect(result.message.content).toContain("no branches were deleted");
    expect(notify).toHaveBeenCalledTimes(1);

    const outside = {
      exec: vi.fn(async () => ({ code: 128, stdout: "", stderr: "", killed: false })),
    } as unknown as Pick<ExtensionAPI, "exec">;
    const outsideBefore = captureHandlers(outside).get("before_agent_start")!;
    expect(
      await outsideBefore(
        {},
        {
          cwd: root,
          hasUI: true,
          isProjectTrusted: () => true,
          ui: { notify: vi.fn() },
        },
      ),
    ).toBeUndefined();
  });
});
