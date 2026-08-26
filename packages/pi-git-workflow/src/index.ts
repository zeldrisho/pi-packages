/**
 * pi-git-workflow Extension
 *
 * Automates git workflow hygiene by:
 * - Running `git fetch --prune` and surfacing repository state before agent starts
 * - Gating branch deletion to ensure branches are merged and upstream is gone
 * - Blocking force deletions (`git branch -D`) to prevent accidental data loss
 * - Providing interactive confirmations when deleting unmerged or tracked branches
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const BRANCH_DELETE_FORCE_RE = /\bgit\s+branch\s+.*(?:-D|--delete\s+--force)\b/;
const BRANCH_DELETE_RE = /\bgit\s+branch\s+.*(?:-d|--delete)\b/;
const BRANCH_NAME_FROM_DELETE_RE = /git\s+branch\s+(?:-d|-D|--delete)(?:\s+--force)?\s+([^\s;|&]+)/;

/**
 * Extracts the branch name from a git branch delete command.
 *
 * @param command - The git command string to parse
 * @returns The branch name if found, otherwise `undefined`
 */
export function extractBranchName(command: string): string | undefined {
  const m = command.match(BRANCH_NAME_FROM_DELETE_RE);
  return m?.[1]?.trim();
}

/**
 * Checks if the current directory is inside a git repository.
 *
 * @param pi - The extension API instance
 * @returns `true` if the current directory is in a git repository
 */
export async function isGitRepo(pi: ExtensionAPI): Promise<boolean> {
  const { code } = await pi.exec("git", ["rev-parse", "--git-dir"]);
  return code === 0;
}

/**
 * Detects the target branch (typically `main` or `master`) for the repository.
 *
 * Checks `origin/HEAD` first, then falls back to checking for `origin/main`,
 * `origin/master`, and finally the current branch. Returns `"main"` as the
 * ultimate fallback.
 *
 * @param pi - The extension API instance
 * @returns The name of the target branch
 */
export async function detectTargetBranch(pi: ExtensionAPI): Promise<string> {
  const { stdout, code } = await pi.exec("git", ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (code === 0 && stdout.trim()) {
    // refs/remotes/origin/main -> main
    const ref = stdout.trim();
    const slash = ref.lastIndexOf("/");
    if (slash !== -1) return ref.slice(slash + 1);
  }
  // fallback: prefer origin/main if exists
  const { code: mainCode } = await pi.exec("git", [
    "rev-parse",
    "--verify",
    "refs/remotes/origin/main",
  ]);
  if (mainCode === 0) return "main";
  const { code: masterCode } = await pi.exec("git", [
    "rev-parse",
    "--verify",
    "refs/remotes/origin/master",
  ]);
  if (masterCode === 0) return "master";
  const { stdout: branchStdout } = await pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  return branchStdout.trim() || "main";
}

/**
 * Checks if a branch has been merged into the target branch.
 *
 * First checks `git branch --merged`, then falls back to
 * `git merge-base --is-ancestor` for a more comprehensive check.
 *
 * @param pi - The extension API instance
 * @param branch - The branch to check
 * @param target - The target branch to check against
 * @returns `true` if the branch is merged into the target
 */
export async function checkMerged(
  pi: ExtensionAPI,
  branch: string,
  target: string,
): Promise<boolean> {
  // git branch --merged <target> lists branches merged into target
  const { stdout, code } = await pi.exec("git", ["branch", "--merged", target]);
  if (code !== 0) return false;
  const lines = stdout
    .split("\n")
    .map((l: string) => l.replace(/^[* ]+/, "").trim())
    .filter(Boolean);
  if (lines.includes(branch)) return true;
  // fallback: merge-base --is-ancestor
  const { code: ancestorCode } = await pi.exec("git", [
    "merge-base",
    "--is-ancestor",
    branch,
    target,
  ]);
  return ancestorCode === 0;
}

/**
 * Checks if the upstream (remote) branch for a local branch has been deleted.
 *
 * Uses multiple checks:
 * 1. `git branch -vv` to see if the branch shows `: gone]`
 * 2. `git ls-remote --heads` to verify the remote branch does not exist
 * 3. `git config` to check if there is no tracking remote configured
 *
 * @param pi - The extension API instance
 * @param branch - The local branch name to check
 * @returns `true` if the upstream branch is gone or was never tracked
 */
export async function checkUpstreamGone(pi: ExtensionAPI, branch: string): Promise<boolean> {
  // 1. git branch -vv shows [origin/branch: gone]
  const { stdout: vv } = await pi.exec("git", ["branch", "-vv"]);
  const goneLine = vv.split("\n").find((l: string) => l.includes(branch) && l.includes(": gone]"));
  if (goneLine) return true;

  // 2. ls-remote --heads origin <branch> empty => no remote branch
  const { stdout: ls, code } = await pi.exec("git", ["ls-remote", "--heads", "origin", branch]);
  if (code === 0 && ls.trim() === "") return true;

  // 3. check config branch.<name>.remote missing or no remote tracking
  const { stdout: remote } = await pi.exec("git", ["config", `branch.${branch}.remote`]);
  if (!remote.trim()) {
    // no tracking remote at all -> considered gone if ls-remote empty
    return ls.trim() === "";
  }
  return false;
}

/**
 * Pi git workflow extension that automates git repository hygiene.
 *
 * Provides two main features:
 * 1. Runs `git fetch --prune` on agent start and surfaces repository state
 * 2. Gates branch deletion commands to ensure branches are safely merged
 *
 * @param pi - The extension API instance
 */
export default function piGitWorkflow(pi: ExtensionAPI): void {
  // Rule 1: run before agent does anything — fetch --prune + inspect
  pi.on("before_agent_start", async (_event, ctx: ExtensionContext) => {
    if (!(await isGitRepo(pi))) return;

    const target = await detectTargetBranch(pi);

    // Always fetch --prune first
    const { code: fetchCode, stderr: fetchErr } = await pi.exec("git", ["fetch", "--prune"]);
    if (fetchCode !== 0) {
      const msg = fetchErr.trim() || "git fetch --prune failed";
      ctx.ui.notify(`pi-git-workflow: ${msg}`, "warning");
      // still inject inspection so agent sees failure
    }

    const { stdout: status } = await pi.exec("git", ["status", "--porcelain"]);
    const dirty = status.trim().length > 0;

    const { stdout: branch } = await pi.exec("git", ["branch", "--show-current"]);
    const currentBranch = branch.trim() || "(detached)";

    const { stdout: vv } = await pi.exec("git", ["branch", "-vv"]);
    const vvLine = vv
      .split("\n")
      .find((l: string) => l.includes(currentBranch))
      ?.trim();

    let upstreamRef = "(no upstream)";
    try {
      const r = await pi.exec("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
      upstreamRef = r.stdout.trim() || "(no upstream)";
    } catch {}

    // If clean and not on target, surface that agent should start from target
    // Never discard dirty work — just report
    let checkoutHint = "";
    if (!dirty && currentBranch !== target) {
      // Check if target exists locally
      const { code: hasTarget } = await pi.exec("git", ["rev-parse", "--verify", target]);
      if (hasTarget === 0) {
        checkoutHint = `\n- Suggested: start from latest \`${target}\` (currently on \`${currentBranch}\`) — run \`git checkout ${target} && git pull --ff-only\` before branching.`;
      } else {
        checkoutHint = `\n- Target \`${target}\` not checked out locally; consider \`git checkout ${target}\`.`;
      }
    } else if (dirty) {
      checkoutHint = `\n- Working tree is DIRTY — do NOT discard uncommitted work. Stash or commit before switching branches.`;
    }

    const lines = [
      `<!-- pi-git-workflow preflight -->`,
      `Git preflight (before_agent_start):`,
      `- fetch --prune: ${fetchCode === 0 ? "ok" : "failed"}`,
      `- target: \`${target}\` (detected from origin/HEAD)`,
      `- current branch: \`${currentBranch}\` ${vvLine ? `(${vvLine})` : ""}`,
      `- upstream: \`${upstreamRef}\``,
      `- status: ${dirty ? "DIRTY" : "clean"}`,
    ];
    if (dirty) {
      const preview = status.trim().split("\n").slice(0, 10).join("\n");
      lines.push(`- dirty files (first 10):\n\`\`\`\n${preview}\n\`\`\``);
    }
    if (checkoutHint) lines.push(checkoutHint);
    lines.push(
      `- Inspect: \`git status --porcelain\`, \`git branch -vv\`, \`git log --oneline ${target}..HEAD\` for local vs upstream.`,
    );

    return {
      message: {
        customType: "pi-git-workflow-preflight",
        content: lines.join("\n"),
        display: false,
      },
    };
  });

  // Rule 2: gate deletion — only when merged into target and upstream gone
  pi.on("tool_call", async (event, ctx: ExtensionContext) => {
    if (event.toolName !== "bash") return;

    // SAFETY: bash tool input always has string command; guard fallback to empty
    const command = (event.input.command as string) ?? "";

    // Always block force delete
    if (BRANCH_DELETE_FORCE_RE.test(command)) {
      const branch = extractBranchName(command) ?? "branch";
      return {
        block: true,
        reason:
          `pi-git-workflow: blocked \`git branch -D\` for \`${branch}\`. ` +
          `Delete only when merged into target and upstream is gone. ` +
          `Use \`git branch -d ${branch}\` after verifying \`git branch --merged <target>\` and \`git ls-remote --heads origin ${branch}\` is empty, or run via pi-git-workflow checks.`,
      };
    }

    if (BRANCH_DELETE_RE.test(command)) {
      const branch = extractBranchName(command);
      if (!branch) return;

      if (!(await isGitRepo(pi))) return;

      const target = await detectTargetBranch(pi);

      // Check if branch exists locally
      const { code: hasBranch } = await pi.exec("git", ["rev-parse", "--verify", branch]);
      if (hasBranch !== 0) {
        // Let git report error itself
        return;
      }

      const merged = await checkMerged(pi, branch, target);
      if (!merged) {
        if (!ctx.hasUI) {
          return {
            block: true,
            reason: `pi-git-workflow: blocked deletion of \`${branch}\` — not merged into \`${target}\` (checked \`git branch --merged ${target}\` and \`git merge-base --is-ancestor\`).`,
          };
        }
        const choice = await ctx.ui.select(
          `Branch \`${branch}\` is NOT merged into \`${target}\`. Delete anyway?`,
          ["No, keep branch", "Yes, delete unmerged"],
        );
        if (choice !== "Yes, delete unmerged") {
          return {
            block: true,
            reason: `pi-git-workflow: deletion of \`${branch}\` cancelled — not merged into \`${target}\`.`,
          };
        }
        return;
      }

      const gone = await checkUpstreamGone(pi, branch);
      if (!gone) {
        if (!ctx.hasUI) {
          return {
            block: true,
            reason: `pi-git-workflow: blocked deletion of \`${branch}\` — upstream still exists ( \`git branch -vv\` not gone and \`git ls-remote --heads origin ${branch}\` not empty). Delete remote first or wait for prune.`,
          };
        }
        const choice = await ctx.ui.select(
          `Branch \`${branch}\` is merged but upstream still exists. Delete local anyway?`,
          ["No, keep until upstream gone", "Yes, delete local now"],
        );
        if (choice !== "Yes, delete local now") {
          return {
            block: true,
            reason: `pi-git-workflow: deletion of \`${branch}\` cancelled — upstream still exists.`,
          };
        }
      }

      // merged && (gone || user confirmed) => allow
      return;
    }

    return;
  });
}
