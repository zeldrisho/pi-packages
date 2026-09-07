# @zeldrisho/pi-git-workflow

Pi extension that prunes remote-tracking refs, safely cleans merged local branches, and gates unsafe branch deletion.

## Install

```bash
pi install npm:@zeldrisho/pi-git-workflow
```

Project-local:

```bash
pi install -l npm:@zeldrisho/pi-git-workflow
```

## Behavior

No commands or tools are registered. The extension attempts cleanup before each agent turn and gates branch deletion in agent `bash` calls.

### Automatic local cleanup

For trusted, non-bare Git worktrees, the extension:

1. resolves and pins the canonical repository root;
2. runs bounded `git fetch --prune origin`;
3. detects and pins the fetched target branch;
4. inspects local refs and linked worktrees with machine-readable Git output; and
5. attempts ordinary `git branch --delete` only for non-current, non-target branches whose configured upstream is gone and whose pinned commit is an ancestor of the fetched target.

Automatic cleanup has a **2-second total deadline**, including repository queue waits, so a slow or unreachable remote cannot hold prompt startup for the usual 30-second Git timeout. On expiry, the active command is signalled to abort and no subsequent cleanup commands are started. The `fetch --prune origin` itself runs outside the per-repository lock: only the ref inspection and deletion phase is serialized per repository root, so a hung fetch never blocks later cleanups past the logical deadline. Concurrent fetches for the same root are safe (each check reads only its own fetch result), and a late-settling fetch from a timed-out attempt never authorizes deletion. Failed automatic inspections pause retries for **60 seconds**; hidden context continues to report that cleanup and upstream freshness are unverified. The pause is keyed by canonical repository root, so all subdirectories of the same monorepo share one cooldown (the cwd → root mapping is cached, so repeat visits cost no extra Git calls). When the root itself cannot be resolved, the pause falls back to the working directory rather than being skipped. The pause is shared with explicit branch-deletion checks: while it is active, a `git branch -d` / `--delete` gate fails fast (still blocked, without spending another fetch) instead of re-probing a known-unreachable remote. A failed gate inspection likewise pauses automatic cleanup. The retry pause never authorizes deletion from cached state — only a fresh successful inspection can allow it.

A deadline or cancellation can occur after earlier cleanup steps completed; it does not roll them back. If fetch times out, check network access and Git authentication outside Pi (for example, run `git fetch --prune origin` in a terminal), then submit another prompt after the retry pause.

Each candidate ref is checked again immediately before deletion. Only the ref inspection and deletion phase is serialized per repository root within the Pi process; the fetch runs outside that lock. Branches are retained if a ref moves, inspection is uncertain, another worktree uses the branch, Git refuses deletion, or a hook fails.

Branches with no upstream, unmerged or squash/rebase-like history, and other unresolved states are listed in bounded hidden agent context for the agent to leave alone. The agent is instructed never to force-delete automatically and never to mention this to the user unless they ask about Git cleanup. No interactive notifications are shown.

After fetching, the extension also compares the checked-out branch with its configured upstream. If it is behind or diverged, Pi receives bounded hidden context instructing the agent to avoid modifying files until synchronized, unless the task explicitly requires it. The extension does not choose or run a merge, rebase, reset, or pull strategy automatically, and does not notify the user.

Git hooks, including reference-transaction hooks, may run with the user's permissions during trusted-repository Git commands. The extension never checks out files and never reloads Pi resources.

### Remote branches

The extension never pushes or deletes remote refs. Remote head-branch deletion remains owned by GitHub's **Automatically delete head branches** repository setting. `fetch --prune` only removes stale local remote-tracking refs.

### Agent deletion gate

The extension always blocks agent calls using `git branch -D`, `--force --delete`, or `--delete --force`.

For ordinary `git branch -d` / `--delete`, it refreshes `origin`, resolves exact refs, and allows the command only when the branch is proven merged into the fetched target and its configured upstream is confirmed gone. Failed or ambiguous inspection is blocked. A successful inspection with a negative verdict (e.g. not merged) does not pause retries; a failed inspection (e.g. unreachable remote) does, and while that pause is active further deletion checks fail fast without another fetch. Ordinary deletion still uses Git's native non-force safety checks.

The entire deletion safety inspection also has a **2-second deadline** and honors the active agent's abort signal (Escape in the TUI). Timeout or cancellation aborts the inspection and blocks deletion. This bounds the extension's mid-conversation tool-preflight wait, which otherwise delays queued steering messages and completion of an abort. It does not change Pi's normal message queueing or bound the execution time of agent tools themselves.

The extension never resets, rebases, merges, stashes, cleans, switches branches, force-deletes, pushes, or calls `ctx.reload()`.

## Uninstall

```bash
pi remove npm:@zeldrisho/pi-git-workflow
```

Project-local:

```bash
pi remove -l npm:@zeldrisho/pi-git-workflow
```

## License

[MIT](LICENSE)
