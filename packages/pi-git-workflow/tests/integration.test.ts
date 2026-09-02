// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { cleanupRepository } from "../src/cleanup";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function command(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout;
}

function realPi(): Pick<ExtensionAPI, "exec"> {
  return {
    exec: async (program, args, options) => {
      try {
        const result = await execFileAsync(program, args, {
          cwd: options?.cwd,
          encoding: "utf8",
          timeout: options?.timeout,
        });
        return { code: 0, stdout: result.stdout, stderr: result.stderr, killed: false };
      } catch (error: any) {
        return {
          code: Number.isInteger(error.code) ? Number(error.code) : 1,
          stdout: error.stdout ?? "",
          stderr: error.stderr ?? error.message,
          killed: Boolean(error.killed),
        };
      }
    },
  };
}

async function fixture(): Promise<{ root: string; remote: string }> {
  const base = await mkdtemp(join(tmpdir(), "pi-git-workflow-"));
  temporaryDirectories.push(base);
  const remote = join(base, "remote.git");
  const seed = join(base, "seed");
  const root = join(base, "work");
  await command(base, ["init", "--bare", "--initial-branch=main", remote]);
  await command(base, ["init", "--initial-branch=main", seed]);
  await command(seed, ["config", "user.name", "Test"]);
  await command(seed, ["config", "user.email", "test@example.invalid"]);
  await writeFile(join(seed, "README.md"), "initial\n");
  await command(seed, ["add", "README.md"]);
  await command(seed, ["commit", "-m", "initial"]);
  await command(seed, ["remote", "add", "origin", remote]);
  await command(seed, ["push", "-u", "origin", "main"]);
  await command(base, ["clone", remote, root]);
  await command(root, ["config", "user.name", "Test"]);
  await command(root, ["config", "user.email", "test@example.invalid"]);
  return { root, remote };
}

async function createTrackedBranch(root: string, name: string): Promise<void> {
  await command(root, ["switch", "-c", name]);
  await writeFile(join(root, `${name.replaceAll("/", "-")}.txt`), `${name}\n`);
  await command(root, ["add", "."]);
  await command(root, ["commit", "-m", name]);
  await command(root, ["push", "-u", "origin", name]);
}

async function deleteRemoteBranch(root: string, name: string): Promise<void> {
  await command(root, ["push", "origin", "--delete", name]);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("real Git cleanup", () => {
  it("deletes a merged local branch after its remote is deleted and pruned", async () => {
    const { root } = await fixture();
    await createTrackedBranch(root, "feature");
    await command(root, ["switch", "main"]);
    await command(root, ["merge", "--no-ff", "feature", "-m", "merge feature"]);
    await command(root, ["push", "origin", "main"]);
    await deleteRemoteBranch(root, "feature");

    const result = await cleanupRepository(realPi(), { cwd: root, trusted: true });
    expect(result.deleted).toEqual(["feature"]);
    await expect(command(root, ["show-ref", "--verify", "refs/heads/feature"])).rejects.toThrow();
  });

  it("retains an upstream-gone branch that is not merged into the target", async () => {
    const { root } = await fixture();
    await createTrackedBranch(root, "abandoned");
    await command(root, ["switch", "main"]);
    await deleteRemoteBranch(root, "abandoned");

    const result = await cleanupRepository(realPi(), { cwd: root, trusted: true });
    expect(result.review.find((item) => item.name === "abandoned")?.reason).toContain("not merged");
    expect(await command(root, ["show-ref", "--verify", "refs/heads/abandoned"])).toContain(
      "refs/heads/abandoned",
    );
  });

  it("does not classify an upstream from an unfetched second remote", async () => {
    const { root } = await fixture();
    const secondary = join(root, "..", "secondary.git");
    await command(root, ["init", "--bare", "--initial-branch=main", secondary]);
    await command(root, ["remote", "add", "secondary", secondary]);
    await command(root, ["push", "--set-upstream", "secondary", "main"]);

    const result = await cleanupRepository(realPi(), { cwd: root, trusted: true });
    expect(result.sync).toEqual({
      branch: "main",
      upstream: "refs/remotes/secondary/main",
      state: "unknown",
    });
  });

  it("retains a merged branch checked out in another worktree", async () => {
    const { root } = await fixture();
    await createTrackedBranch(root, "occupied");
    await command(root, ["switch", "main"]);
    await command(root, ["merge", "--no-ff", "occupied", "-m", "merge occupied"]);
    await command(root, ["push", "origin", "main"]);
    await deleteRemoteBranch(root, "occupied");
    await command(root, ["worktree", "add", join(root, "..", "linked"), "occupied"]);

    const result = await cleanupRepository(realPi(), { cwd: root, trusted: true });
    expect(result.review.find((item) => item.name === "occupied")?.reason).toContain("worktree");
  });

  it("retains a squash-merge-like branch for review", async () => {
    const { root } = await fixture();
    await createTrackedBranch(root, "squashed");
    await command(root, ["switch", "main"]);
    await command(root, ["merge", "--squash", "squashed"]);
    await command(root, ["commit", "-m", "squash feature"]);
    await command(root, ["push", "origin", "main"]);
    await deleteRemoteBranch(root, "squashed");

    const result = await cleanupRepository(realPi(), { cwd: root, trusted: true });
    expect(result.review.find((item) => item.name === "squashed")?.reason).toContain("not merged");
  });

  it("retains a ref that moves between inspection and deletion", async () => {
    const { root } = await fixture();
    await createTrackedBranch(root, "moving");
    await command(root, ["switch", "main"]);
    await command(root, ["merge", "--no-ff", "moving", "-m", "merge moving"]);
    await command(root, ["push", "origin", "main"]);
    await deleteRemoteBranch(root, "moving");
    const delegate = realPi();
    let moved = false;
    const pi = {
      exec: async (
        program: string,
        args: string[],
        options?: Parameters<ExtensionAPI["exec"]>[2],
      ) => {
        const result = await delegate.exec(program, args, options);
        if (!moved && args[0] === "merge-base") {
          moved = true;
          const commit = (
            await command(root, [
              "commit-tree",
              "moving^{tree}",
              "-p",
              "moving",
              "-m",
              "concurrent move",
            ])
          ).trim();
          await command(root, ["update-ref", "refs/heads/moving", commit]);
        }
        return result;
      },
    } as Pick<ExtensionAPI, "exec">;

    const result = await cleanupRepository(pi, { cwd: root, trusted: true });
    expect(result.review.find((item) => item.name === "moving")?.reason).toContain("moved");
  });

  it("retains a candidate when a reference-transaction hook rejects deletion", async () => {
    const { root } = await fixture();
    await createTrackedBranch(root, "hooked");
    await command(root, ["switch", "main"]);
    await command(root, ["merge", "--no-ff", "hooked", "-m", "merge hooked"]);
    await command(root, ["push", "origin", "main"]);
    await deleteRemoteBranch(root, "hooked");
    const hooks = (await command(root, ["rev-parse", "--git-path", "hooks"])).trim();
    const hook = join(isAbsolute(hooks) ? hooks : resolve(root, hooks), "reference-transaction");
    await writeFile(
      hook,
      "#!/bin/sh\n[ \"$1\" = prepared ] && grep -q 'refs/heads/hooked' && exit 1\nexit 0\n",
    );
    await chmod(hook, 0o700);

    const result = await cleanupRepository(realPi(), { cwd: root, trusted: true });
    expect(result.review.find((item) => item.name === "hooked")?.reason).toContain("refused");
  });
});
