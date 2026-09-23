---
name: pr-writer
description: Use this skill to draft or update a pull request title and reviewer-facing body, or prepare branch changes for review. Inspect the full branch diff and focus the cover note on behavior, impact, risk, and migration. Do not create, edit, commit, push, or publish anything unless the user explicitly asks for that action.
compatibility: Git is required to inspect branch history. GitHub CLI (`gh`) and authentication are needed only when the user requests reading or changing a hosted PR.
---

# PR Writer

Write a concise reviewer cover note, not a changelog, validation log, or file-by-file summary.

## Choose the requested mode

- **Draft** (default): inspect available local changes and suggest a title/body. Do not create a branch, commit, push, open a PR, or call a mutation API.
- **Read hosted PR**: use authenticated `gh` only when needed to inspect an existing PR.
- **Create or update hosted PR**: do so only when the user explicitly requests that action. Confirm target PR/repository and title/body before mutation if ambiguous. New PRs are drafts unless the user requests otherwise.
- Never commit, push, or create a branch unless separately and explicitly requested.

If `gh` is unavailable or unauthenticated, continue in Draft mode using local Git data; explain only what could not be inspected.

## Inspect the change

```bash
git branch --show-current
git status --porcelain
git diff --stat
git diff
```

For a hosted PR, inspect its base/head and full branch diff. Use the PR base when present; otherwise use the repository default branch:

```bash
gh pr view --json number,title,body,url,baseRefName,headRefName
gh repo view --json defaultBranchRef
git log "$BASE"..HEAD --oneline
git diff "$BASE"...HEAD
```

Do not assume the working tree is clean, changes are committed, or that the latest commit represents the whole PR. Do not switch branches or alter user changes merely to prepare a draft.

## Title

Use `<type>(<scope>): <subject>` or `<type>: <subject>`.

Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, and `revert`.

- Describe the dominant full-branch change with the narrowest accurate type and scope.
- Use `!` only for an external contract break, and explain the affected surface.
- Avoid vague subjects and trailing periods.
- Keep an existing title only if it describes the whole change.

## Body

Choose the minimum useful shape:

| Change                         | Include                                                   |
| ------------------------------ | --------------------------------------------------------- |
| Small or obvious               | One concise paragraph.                                    |
| Feature, bug fix, or refactor  | Behavior and effect; root cause or approach when useful.  |
| Contract or breaking change    | Affected surface, compatibility, and migration.           |
| Operational or workflow change | User/operator effect, impact, and relevant failure modes. |
| Broad or cross-cutting         | Organizing principle and where review should start.       |

Default:

```markdown
<What changed and what effect it has.>

<Why the approach, risk, migration, or review focus matters, if not obvious.>
```

For review-feedback updates, describe the resulting PR as a whole, not the sequence of revisions.

## Boundaries

- Do not add default `Summary`, `Changes`, or `Test Plan` sections.
- Omit routine validation unless it affects risk or meaningful regression coverage.
- Do not paste commands, CI logs, commit logs, placeholders, or exhaustive file lists.
- Never include secrets, PII, customer names, or support-ticket contents.
- Use issue references only when verified from user input, branch, commits, PR discussion, or tracker output. `Fixes` closes an issue; `Refs` only links.

## Hosted PR mutations

Only enter this section after explicit user authorization to create or update a hosted PR. Verify repository, base, title, and body. Prefer draft creation. Write the confirmed body to a temporary Markdown file before invoking a mutation:

```bash
gh pr create --draft --title '<title>' --body-file /tmp/pr-body.md
```

Update only the explicitly identified PR:

```bash
gh api -X PATCH repos/{owner}/{repo}/pulls/PR_NUMBER \
  -f title='<title>' \
  -F body=@/tmp/pr-body.md
```

Refresh an existing title/body only when follow-up changes materially alter scope, behavior, risk, migration, or review expectations. Skip typo-only, formatting-only, and rename-only changes.
