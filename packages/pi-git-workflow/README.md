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

No commands or tools are registered. The extension runs cleanup before each agent turn and gates branch deletion in agent `bash` calls.

### Automatic local cleanup

For trusted, non-bare Git worktrees, the extension:

1. resolves and pins the canonical repository root;
2. runs bounded `git fetch --prune origin`;
3. detects and pins the fetched target branch;
4. inspects local refs and linked worktrees with machine-readable Git output; and
5. attempts ordinary `git branch --delete` only for non-current, non-target branches whose configured upstream is gone and whose pinned commit is an ancestor of the fetched target.

Each candidate ref is checked again immediately before deletion. Cleanup is serialized per repository root within the Pi process. Branches are retained if a ref moves, inspection is uncertain, another worktree uses the branch, Git refuses deletion, or a hook fails.

Branches with no upstream, unmerged or squash/rebase-like history, and other unresolved states are listed in bounded hidden agent context. The agent is instructed to tell the user and never force-delete automatically. Interactive notifications are concise and repeat only when the candidate set changes.

After fetching, the extension also compares the checked-out branch with its configured upstream. If it is behind or diverged, Pi receives bounded hidden context requiring the agent to tell the user and synchronize before modifying files. The extension warns once per observed state, but does not choose or run a merge, rebase, reset, or pull strategy automatically.

Git hooks, including reference-transaction hooks, may run with the user's permissions during trusted-repository Git commands. The extension never checks out files and never reloads Pi resources.

### Remote branches

The extension never pushes or deletes remote refs. Remote head-branch deletion remains owned by GitHub's **Automatically delete head branches** repository setting. `fetch --prune` only removes stale local remote-tracking refs.

### Agent deletion gate

The extension always blocks agent calls using `git branch -D`, `--force --delete`, or `--delete --force`.

For ordinary `git branch -d` / `--delete`, it refreshes `origin`, resolves exact refs, and allows the command only when the branch is proven merged into the fetched target and its configured upstream is confirmed gone. Failed or ambiguous inspection is blocked. Ordinary deletion still uses Git's native non-force safety checks.

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
