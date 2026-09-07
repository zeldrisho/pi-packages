/** Pi extension for safe local Git branch cleanup and deletion gating. */
import {
  isToolCallEventType,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  cleanupRepository,
  formatCleanupContext,
  formatSyncContext,
  parseLocalBranches,
} from "./cleanup";
import {
  AUTOMATIC_CLEANUP_RETRY_MS,
  detectTargetBranchInRepo,
  exactRefCommit,
  git,
  GitInspectionError,
  requireBoundedOutput,
  requireGitOk,
  resolveRepoRoot,
  sanitizeGitOutput,
  withGitDeadline,
} from "./git";

const BRANCH_DELETE_FORCE_RE =
  /\bgit\s+branch\b(?=[^;&|\n]*(?:-D\b|--delete\b|-d\b|-[A-Za-z]*[dD][A-Za-z]*f|-[A-Za-z]*f[A-Za-z]*[dD]))(?=[^;&|\n]*(?:-D\b|--force\b|-f\b|-[A-Za-z]*[dD][A-Za-z]*f|-[A-Za-z]*f[A-Za-z]*[dD]))/;
const BRANCH_DELETE_RE = /\bgit\s+branch\s+.*(?:-d|--delete)\b/;
const BRANCH_NAME_FROM_DELETE_RE =
  /git\s+branch\s+(?:(?:-d|-D|--delete)(?:\s+--force)?|--force\s+--delete)\s+(?:--\s+)?([^\s;|&]+)/;

/**
 * Extract the branch name from a git branch delete command.
 *
 * Parses various forms of git branch deletion commands to extract the
 * target branch name.
 *
 * @param command - Git command string to parse
 * @returns Branch name if found, undefined otherwise
 */
export function extractBranchName(command: string): string | undefined {
  return command.match(BRANCH_NAME_FROM_DELETE_RE)?.[1]?.trim();
}

/** Shared retry-pause state: key -> { retryAt, error }. Keyed by cwd for now. */
type BackoffMap = Map<string, { retryAt: number; error: Error }>;

/**
 * Return the stored error if `key` is inside its retry-pause window.
 *
 * @param failures - Shared backoff state
 * @param key - Backoff key to inspect
 * @returns The stored error while paused, undefined otherwise
 */
function getBackoff(failures: BackoffMap, key: string): Error | undefined {
  const previous = failures.get(key);
  if (previous && Date.now() < previous.retryAt) return previous.error;
  return undefined;
}

/**
 * Record a retry pause for `key`.
 *
 * @param failures - Shared backoff state
 * @param key - Backoff key to pause
 * @param error - Failure that triggered the pause
 */
function noteBackoff(failures: BackoffMap, key: string, error: Error): void {
  failures.set(key, { retryAt: Date.now() + AUTOMATIC_CLEANUP_RETRY_MS, error });
}

/**
 * Decide whether an inspection failure should pause retries.
 *
 * Non-repository directories and untrusted projects are stable states, not
 * transient remote failures, so they never trigger backoff.
 *
 * @param error - Inspection failure to classify
 * @returns True when the failure should pause retries
 */
function isBackoffable(error: Error): boolean {
  return (
    !(error instanceof GitInspectionError) ||
    (error.code !== "not_git_worktree" && error.code !== "untrusted_project")
  );
}

/**
 * Pi extension for Git workflow management and branch deletion safety.
 *
 * Automatically inspects and cleans up merged local branches, and gates
 * force-delete operations to prevent accidental data loss.
 *
 * @param pi - Extension API instance
 */
export default function piGitWorkflow(pi: ExtensionAPI): void {
  const failures = new Map<string, { retryAt: number; error: Error }>();

  pi.on("before_agent_start", async (_event, ctx: ExtensionContext) => {
    if (!ctx.isProjectTrusted()) return;
    try {
      const paused = getBackoff(failures, ctx.cwd);
      if (paused) throw paused;
      failures.delete(ctx.cwd);
      const result = await withGitDeadline(
        pi,
        (runner) => cleanupRepository(runner, { cwd: ctx.cwd, trusted: true }),
        ctx.signal,
      );
      const syncContext = formatSyncContext(result.sync);

      const content = [formatCleanupContext(result.review), syncContext]
        .filter(Boolean)
        .join("\n\n");
      if (!content) return;
      return {
        message: { customType: "pi-git-workflow-cleanup", content, display: false },
      };
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error("unknown Git inspection failure");
      if (
        error instanceof GitInspectionError &&
        (error.code === "not_git_worktree" || error.code === "untrusted_project")
      )
        return;
      if (!failures.has(ctx.cwd)) {
        noteBackoff(failures, ctx.cwd, error);
      }
      const message = `${formatInspectionFailure(error)}. Automatic cleanup retries are paused for up to 60 seconds.`;
      return {
        message: {
          customType: "pi-git-workflow-cleanup",
          content: [
            "<!-- pi-git-workflow cleanup -->",
            "Git branch cleanup inspection was incomplete; cleanup and upstream freshness are not verified.",
            "Some earlier cleanup steps may have completed; inspect refs before retrying deletion.",
            `Reason: ${message}`,
            "Do not mention this to the user unless they ask about Git cleanup. Do not force-delete branches automatically.",
          ].join("\n"),
          display: false,
        },
      };
    }
  });

  pi.on("tool_call", async (event, ctx: ExtensionContext) => {
    if (!isToolCallEventType("bash", event)) return;
    const command = event.input.command;

    if (BRANCH_DELETE_FORCE_RE.test(command)) {
      const branch = extractBranchName(command) ?? "branch";
      return {
        block: true,
        reason: `pi-git-workflow: blocked force deletion of ${formatBranch(branch)}. Never force-delete branches automatically.`,
      };
    }
    if (!BRANCH_DELETE_RE.test(command)) return;
    const branch = extractBranchName(command);
    if (!branch) return;
    if (!ctx.isProjectTrusted())
      return blocked(branch, "project is not trusted, so deletion safety cannot be inspected");

    // Share the automatic-cleanup backoff: while a pause is active for this
    // directory the remote is already known to be unreachable, so fail fast
    // (still blocked) instead of spending another 2-second fetch. The pause
    // never authorizes deletion — only successful fresh inspection allows it.
    const paused = getBackoff(failures, ctx.cwd);
    if (paused) {
      return blocked(
        branch,
        `a recent Git inspection failed (${formatInspectionFailure(paused)}) and retries are paused; retry after the backoff window`,
      );
    }

    try {
      return await withGitDeadline(
        pi,
        async (runner) => {
          const root = await resolveRepoRoot(runner, ctx.cwd);
          await requireGitOk(
            runner,
            root,
            ["fetch", "--prune", "origin"],
            "fetch_failed",
            "git fetch --prune origin failed",
          );
          const target = await detectTargetBranchInRepo(runner, root);
          const branchRef = `refs/heads/${branch}`;
          const branchCommit = await exactRefCommit(runner, root, branchRef);
          if (!branchCommit) return blocked(branch, "the local branch ref is missing or ambiguous");
          const targetCommit = await exactRefCommit(runner, root, `refs/remotes/origin/${target}`);
          if (!targetCommit) return blocked(branch, "the fetched target ref is missing");
          const merged = await git(runner, root, [
            "merge-base",
            "--is-ancestor",
            branchCommit,
            targetCommit,
          ]);
          requireBoundedOutput(merged, "merge relationship inspection");
          if (merged.code !== 0) {
            return blocked(branch, `it is not proven merged into the refreshed target ${target}`);
          }
          if (!(await upstreamGoneInRepo(runner, root, branch))) {
            return blocked(
              branch,
              "its configured upstream is not confirmed gone after fetch --prune",
            );
          }
          return;
        },
        ctx.signal,
      );
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error("unknown Git inspection failure");
      // A failed gate inspection (e.g. unreachable remote) pauses retries for
      // automatic cleanup too. Successful-but-negative verdicts return above
      // and never reach this path, so they never trigger backoff.
      if (isBackoffable(error) && !failures.has(ctx.cwd)) {
        noteBackoff(failures, ctx.cwd, error);
      }
      return blocked(branch, `safety inspection failed: ${formatInspectionFailure(error)}`);
    }
  });
}

/**
 * Checks if a branch's configured upstream is marked as gone after pruning.
 *
 * @param pi - Git command runner interface
 * @param root - Repository root directory
 * @param branch - Branch name to check
 * @returns Promise resolving to true if upstream is gone, false otherwise
 */
async function upstreamGoneInRepo(
  pi: Pick<ExtensionAPI, "exec">,
  root: string,
  branch: string,
): Promise<boolean> {
  const result = await requireGitOk(
    pi,
    root,
    [
      "for-each-ref",
      "--format=%(refname)%00%(objectname)%00%(upstream)%00%(upstream:track)%00",
      `refs/heads/${branch}`,
    ],
    "upstream_inspection_failed",
    "failed to inspect branch upstream",
  );
  const metadata = parseLocalBranches(result.stdout).find((item) => item.name === branch);
  return Boolean(metadata?.upstream && metadata.tracking.trim() === "[gone]");
}

/**
 * Creates a tool call block result with a formatted reason.
 *
 * @param branch - Branch name being deleted
 * @param reason - Reason for blocking the deletion
 * @returns Block result object for tool call interception
 */
function blocked(branch: string, reason: string) {
  return {
    block: true,
    reason: `pi-git-workflow: blocked ordinary deletion of ${formatBranch(branch)} — ${reason}. Git branch --delete cannot override an unmerged-branch refusal.`,
  };
}

/**
 * Formats a branch name for display, truncating if too long and JSON-escaping.
 *
 * @param branch - Branch name to format
 * @returns JSON-escaped branch name, truncated to 300 characters if needed
 */
function formatBranch(branch: string): string {
  return JSON.stringify(branch.length > 300 ? `${branch.slice(0, 300)}…` : branch);
}

/**
 * Formats an error from Git inspection for user-facing messages.
 *
 * @param error - Error to format
 * @returns Formatted error message with sanitized details
 */
function formatInspectionFailure(error: Error): string {
  if (error instanceof GitInspectionError) {
    return `${error.message}${error.details ? ` (${error.details})` : ""}`;
  }
  return sanitizeGitOutput(error.message) ?? "unknown Git inspection failure";
}
