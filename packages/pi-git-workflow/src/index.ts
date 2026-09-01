/** Pi extension for safe local Git branch cleanup and deletion gating. */
import {
  isToolCallEventType,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  cleanupRepository,
  formatCleanupContext,
  parseLocalBranches,
  reviewFingerprint,
} from "./cleanup";
import {
  detectTargetBranchInRepo,
  exactRefCommit,
  git,
  GitInspectionError,
  requireBoundedOutput,
  requireGitOk,
  resolveRepoRoot,
  sanitizeGitOutput,
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

/**
 * Pi extension for Git workflow management and branch deletion safety.
 *
 * Automatically inspects and cleans up merged local branches, and gates
 * force-delete operations to prevent accidental data loss.
 *
 * @param pi - Extension API instance
 */
export default function piGitWorkflow(pi: ExtensionAPI): void {
  const visibleFingerprints = new Map<string, string>();

  pi.on("before_agent_start", async (_event, ctx: ExtensionContext) => {
    try {
      const result = await cleanupRepository(pi, {
        cwd: ctx.cwd,
        trusted: ctx.isProjectTrusted(),
      });
      const fingerprint = reviewFingerprint(result.review);
      if (result.review.length > 0 && visibleFingerprints.get(result.root) !== fingerprint) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            `pi-git-workflow: ${result.review.length} local ${result.review.length === 1 ? "branch requires" : "branches require"} cleanup review.`,
            "warning",
          );
          visibleFingerprints.set(result.root, fingerprint);
        }
      } else if (result.review.length === 0) {
        visibleFingerprints.delete(result.root);
      }
      const content = formatCleanupContext(result.review);
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
      const fingerprint = `${ctx.cwd}:${error instanceof GitInspectionError ? error.code : "unknown"}`;
      const message = formatInspectionFailure(error);
      if (ctx.hasUI && visibleFingerprints.get(ctx.cwd) !== fingerprint) {
        ctx.ui.notify(`pi-git-workflow: ${message}`, "warning");
        visibleFingerprints.set(ctx.cwd, fingerprint);
      }
      return {
        message: {
          customType: "pi-git-workflow-cleanup",
          content: [
            "<!-- pi-git-workflow cleanup -->",
            "Git branch cleanup inspection was incomplete; no branches were deleted.",
            `Reason: ${message}`,
            "Tell the user cleanup could not be verified. Do not force-delete branches automatically.",
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

    try {
      const root = await resolveRepoRoot(pi, ctx.cwd);
      await requireGitOk(
        pi,
        root,
        ["fetch", "--prune", "origin"],
        "fetch_failed",
        "git fetch --prune origin failed",
      );
      const target = await detectTargetBranchInRepo(pi, root);
      const branchRef = `refs/heads/${branch}`;
      const branchCommit = await exactRefCommit(pi, root, branchRef);
      if (!branchCommit) return blocked(branch, "the local branch ref is missing or ambiguous");
      const targetCommit = await exactRefCommit(pi, root, `refs/remotes/origin/${target}`);
      if (!targetCommit) return blocked(branch, "the fetched target ref is missing");
      const merged = await git(pi, root, [
        "merge-base",
        "--is-ancestor",
        branchCommit,
        targetCommit,
      ]);
      requireBoundedOutput(merged, "merge relationship inspection");
      if (merged.code !== 0) {
        return blocked(branch, `it is not proven merged into the refreshed target ${target}`);
      }
      if (!(await upstreamGoneInRepo(pi, root, branch))) {
        return blocked(branch, "its configured upstream is not confirmed gone after fetch --prune");
      }
      return;
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error("unknown Git inspection failure");
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
