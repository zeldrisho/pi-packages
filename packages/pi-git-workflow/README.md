# @zeldrisho/pi-git-workflow

Pi extension that enforces git workflow before the agent does anything and gates unsafe branch deletion.

## Install

```bash
pi install npm:@zeldrisho/pi-git-workflow
```

Project-local:

```bash
pi install -l npm:@zeldrisho/pi-git-workflow
```

## Behavior

No tools are registered — the extension runs automatically and gates `bash`.

- **Before implementation (`before_agent_start`):** runs `git fetch --prune`, inspects `git status --porcelain`, `git branch -vv`, and upstream (`@{u}`), detects target branch from `refs/remotes/origin/HEAD` (fallback `origin/main` → `origin/master`), and injects a hidden context message with the result. If the working tree is dirty, it never discards work — it reports dirty files and suggests stashing/committing before switching. If clean and not on target, it suggests `git checkout <target> && git pull --ff-only` before branching.

- **Delete branch (`tool_call` gate):** blocks `git branch -D` / `git branch --delete --force` always. For `git branch -d`, it verifies:
  1. `git branch --merged <target>` or `git merge-base --is-ancestor <branch> <target>`
  2. upstream gone — `git branch -vv` shows `: gone` or `git ls-remote --heads origin <branch>` is empty

  If not merged or upstream still exists, it blocks in headless modes (`-p`, JSON) and prompts with `select` in interactive mode. Merged + gone passes through.

No `systemPrompt` injection. Search `pi.dev/packages` with `site:pi.dev/packages <keyword>` (add keyword beside site filter).

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
