import { realpath } from "node:fs/promises";
import type { ExtensionAPI, ExecResult } from "@earendil-works/pi-coding-agent";

/** Default timeout in milliseconds for Git operations. */
export const GIT_TIMEOUT_MS = 30_000;

/** Maximum size in bytes for Git command output to prevent memory exhaustion. */
export const MAX_GIT_OUTPUT_BYTES = 1_000_000;

/** Minimal interface for executing Git commands. */
export type GitRunner = Pick<ExtensionAPI, "exec">;

/**
 * Error thrown when Git repository inspection operations fail.
 *
 * Includes an error code for programmatic handling and optional details
 * for diagnostic context.
 */
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

/**
 * Execute a Git command with the specified arguments.
 *
 * @param pi - Git command runner interface
 * @param cwd - Working directory for the Git command
 * @param args - Array of command-line arguments for Git
 * @param timeout - Optional timeout in milliseconds (defaults to GIT_TIMEOUT_MS)
 * @returns Promise resolving to the command execution result
 */
export async function git(
  pi: GitRunner,
  cwd: string,
  args: string[],
  timeout = GIT_TIMEOUT_MS,
): Promise<ExecResult> {
  try {
    return await pi.exec("git", args, { cwd, timeout });
  } catch (error) {
    throw new GitInspectionError(
      "git_command_failed",
      "Git command failed or timed out",
      error instanceof Error ? sanitizeGitOutput(error.message) : undefined,
    );
  }
}

/**
 * Sanitize Git command output by removing control characters and limiting length.
 *
 * Strips ANSI escape codes and normalizes whitespace to make output safe
 * for display in error messages and logs.
 *
 * @param value - Raw Git output to sanitize
 * @param max - Maximum length for the sanitized output (defaults to 600)
 * @returns Sanitized string, or undefined if the input is empty after cleaning
 */
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

/**
 * Validate that a Git command result has bounded output size.
 *
 * Throws GitInspectionError if stdout or stderr exceeds MAX_GIT_OUTPUT_BYTES
 * to prevent memory exhaustion from unexpectedly large Git responses.
 *
 * @param result - Git command execution result to validate
 * @param operation - Description of the operation for error messages
 * @throws {GitInspectionError} When output exceeds the maximum allowed size
 */
export function requireBoundedOutput(result: ExecResult, operation: string): void {
  if (result.killed) {
    throw new GitInspectionError(
      "git_command_killed",
      `${operation} was killed or timed out`,
      sanitizeGitOutput(result.stderr),
    );
  }
  if (
    Buffer.byteLength(result.stdout, "utf8") > MAX_GIT_OUTPUT_BYTES ||
    Buffer.byteLength(result.stderr, "utf8") > MAX_GIT_OUTPUT_BYTES
  ) {
    throw new GitInspectionError("output_too_large", `${operation} returned too much data`);
  }
}

/**
 * Execute a Git command and require successful completion.
 *
 * Runs the specified Git command, validates its output is bounded, and throws
 * a GitInspectionError if the command exits with a non-zero status.
 *
 * @param pi - Git command runner interface
 * @param cwd - Working directory for the Git command
 * @param args - Array of command-line arguments for Git
 * @param code - Error code to use if the command fails
 * @param message - Error message to use if the command fails
 * @returns Promise resolving to the successful command execution result
 * @throws {GitInspectionError} When the command fails or output is too large
 */
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

/**
 * Resolve a canonical, non-bare Git worktree root.
 *
 * Verifies the current directory is inside a Git working tree (not bare),
 * and returns the canonicalized absolute path to the repository root.
 *
 * @param pi - Git command runner interface
 * @param cwd - Working directory to inspect
 * @returns Promise resolving to the absolute repository root path
 * @throws {GitInspectionError} When not in a worktree or repository is bare
 */
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

/**
 * Detect the target branch name for the repository.
 *
 * Attempts to determine the main development branch by checking:
 * 1. The symbolic ref origin/HEAD points to
 * 2. Existence of common branch names (main, master)
 * 3. The current branch if others are not found
 *
 * @param pi - Git command runner interface
 * @param cwd - Working directory containing the Git repository
 * @returns Promise resolving to the target branch name
 * @throws {GitInspectionError} When target detection fails or HEAD is detached
 */
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

/**
 * Get the exact commit SHA that a Git reference points to.
 *
 * Resolves the given ref to a commit object and validates the format.
 * Returns undefined if the ref does not exist or does not point to a commit.
 *
 * @param pi - Git command runner interface
 * @param cwd - Working directory containing the Git repository
 * @param ref - Git reference name to resolve
 * @returns Promise resolving to the commit SHA (40-64 hex chars), or undefined
 * @throws {GitInspectionError} When output validation fails
 */
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
