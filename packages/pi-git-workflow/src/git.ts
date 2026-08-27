import { realpath } from "node:fs/promises";
import type { ExtensionAPI, ExecResult } from "@earendil-works/pi-coding-agent";

export const GIT_TIMEOUT_MS = 30_000;
export const MAX_GIT_OUTPUT_BYTES = 1_000_000;

export type GitRunner = Pick<ExtensionAPI, "exec">;

export class GitInspectionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: string,
  ) {
    super(message);
    this.name = "GitInspectionError";
  }
}

export async function git(
  pi: GitRunner,
  cwd: string,
  args: string[],
  timeout = GIT_TIMEOUT_MS,
): Promise<ExecResult> {
  return pi.exec("git", args, { cwd, timeout });
}

export function sanitizeGitOutput(value: string, max = 600): string | undefined {
  const clean = Array.from(value, (character) => {
    const code = character.codePointAt(0) ?? 0;
    if (code === 27 || code === 155) return "";
    if (code === 0 || code === 127 || code < 32) return " ";
    return character;
  })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return undefined;
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

export function requireBoundedOutput(result: ExecResult, operation: string): void {
  if (
    Buffer.byteLength(result.stdout, "utf8") > MAX_GIT_OUTPUT_BYTES ||
    Buffer.byteLength(result.stderr, "utf8") > MAX_GIT_OUTPUT_BYTES
  ) {
    throw new GitInspectionError("output_too_large", `${operation} returned too much data`);
  }
}

export async function requireGitOk(
  pi: GitRunner,
  cwd: string,
  args: string[],
  code: string,
  message: string,
): Promise<ExecResult> {
  const result = await git(pi, cwd, args);
  requireBoundedOutput(result, message);
  if (result.code !== 0) {
    throw new GitInspectionError(code, message, sanitizeGitOutput(result.stderr));
  }
  return result;
}

/** Resolve a canonical, non-bare Git worktree root. */
export async function resolveRepoRoot(pi: GitRunner, cwd: string): Promise<string> {
  const inside = await git(pi, cwd, ["rev-parse", "--is-inside-work-tree"]);
  requireBoundedOutput(inside, "repository inspection");
  if (inside.code !== 0 || inside.stdout.trim() !== "true") {
    throw new GitInspectionError("not_git_worktree", "not inside a Git working tree");
  }
  const bare = await requireGitOk(
    pi,
    cwd,
    ["rev-parse", "--is-bare-repository"],
    "bare_check_failed",
    "failed to inspect repository type",
  );
  if (bare.stdout.trim() !== "false") {
    throw new GitInspectionError(
      "bare_repository",
      "bare repositories are not eligible for cleanup",
    );
  }
  const root = await requireGitOk(
    pi,
    cwd,
    ["rev-parse", "--show-toplevel"],
    "repo_root_failed",
    "failed to resolve repository root",
  );
  const path = root.stdout.trim();
  if (!path)
    throw new GitInspectionError("repo_root_failed", "Git returned an empty repository root");
  try {
    return await realpath(path);
  } catch (error) {
    throw new GitInspectionError(
      "repo_root_failed",
      "failed to canonicalize repository root",
      error instanceof Error ? sanitizeGitOutput(error.message) : undefined,
    );
  }
}

export async function detectTargetBranchInRepo(pi: GitRunner, cwd: string): Promise<string> {
  const symbolic = await git(pi, cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  requireBoundedOutput(symbolic, "target detection");
  const prefix = "refs/remotes/origin/";
  const ref = symbolic.stdout.trim();
  if (symbolic.code === 0 && ref.startsWith(prefix) && ref.length > prefix.length) {
    return ref.slice(prefix.length);
  }
  for (const name of ["main", "master"]) {
    const candidate = await git(pi, cwd, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/remotes/origin/${name}`,
    ]);
    if (candidate.code === 0) return name;
    if (candidate.code !== 1)
      throw new GitInspectionError("target_detection_failed", "failed to inspect target refs");
  }
  const current = await requireGitOk(
    pi,
    cwd,
    ["branch", "--show-current"],
    "target_detection_failed",
    "failed to detect target branch",
  );
  if (!current.stdout.trim())
    throw new GitInspectionError("detached_head", "cannot detect a target from detached HEAD");
  return current.stdout.trim();
}

export async function exactRefCommit(
  pi: GitRunner,
  cwd: string,
  ref: string,
): Promise<string | undefined> {
  const result = await git(pi, cwd, ["rev-parse", "--verify", `${ref}^{commit}`]);
  requireBoundedOutput(result, "ref inspection");
  if (result.code !== 0) return undefined;
  const commit = result.stdout.trim();
  return /^[0-9a-f]{40,64}$/i.test(commit) ? commit : undefined;
}
