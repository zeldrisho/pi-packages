---
name: pr-writer
description: Use this skill when opening a pull request, refreshing an existing PR title or body, or preparing branch changes for review. Inspect the full branch diff and write a concise reviewer-facing title and cover note focused on behavior, impact, risk, and migration.
---

# PR Writer

Write the PR body as a cover note for reviewers, not a changelog, template,
validation log, or file-by-file summary.

## Inspect the Change

Requires authenticated `gh`. Inspect the current branch, working tree, PR,
base branch, commits, and full diff:

```bash
git branch --show-current
git status --porcelain
gh pr view --json number,title,body,url,baseRefName,headRefName
gh repo view --json defaultBranchRef
```

If `gh pr view` reports that no PR exists, continue with first-time PR
creation. For an existing PR, use its `baseRefName`; otherwise use the
repository default branch. Set `BASE`, then inspect:

```bash
git log "$BASE"..HEAD --oneline
git diff "$BASE"...HEAD
```

If on `main` or `master`, create a feature branch first. Ensure intended
changes are committed and review the whole branch diff, not only the latest
commit or existing PR text.

## Titles

Use `<type>(<scope>): <subject>` or `<type>: <subject>`.

Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`,
`build`, `ci`, `chore`, and `revert`.

- Describe the dominant full-branch change with the narrowest accurate type
  and scope.
- Use `!` only when the change breaks an external contract, and explain the
  affected surface in the body.
- Avoid vague subjects such as `update`, `cleanup`, `misc`, `fix stuff`,
  or `address feedback`. Do not add a trailing period.
- Keep an existing title only when it still describes the whole diff.

## Body Shape

Choose the minimum useful shape:

| Change                                    | Include                                                                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Small or obvious                          | One concise paragraph without headings.                                                                                   |
| Feature, bug fix, or refactor             | Changed behavior and effect; add root cause, unchanged behavior, or non-obvious approach when relevant.                   |
| Contract or breaking change               | Affected API, schema, payload, config, permission, storage, or CLI surface; include compatibility and migration guidance. |
| Operational, visual, or workflow change   | User/operator effect, measured impact, failure modes, or flow when useful.                                                |
| Broad, generated, or cross-cutting change | Organizing principle, why the breadth is necessary, and where review should start.                                        |

Default:

```markdown
<What changed and what effect it has.>

<Why the approach, risk, migration, or review focus matters, if not obvious.>
```

For review-feedback updates, describe the resulting PR as a whole rather than
the sequence of revisions.

## Boundaries

- Do not add default `Summary`, `Changes`, or `Test Plan` sections.
- Omit routine validation unless it changes risk assessment or explains
  meaningful regression coverage. For docs, skills, copy, or config changes,
  omit it by default.
- Do not paste commands, CI logs, validation dumps, commit logs, placeholders,
  or exhaustive file lists.
- Never include customer or organization names, user emails, support ticket
  contents, secrets, or PII.
- Use issue references only when verified from user input, branch names,
  commits, PR discussion, or tracker output. `Fixes <issue>` closes;
  `Refs <issue>` only links.

## Create or Update

Create new PRs as drafts. Write the body to a temporary Markdown file, then run:

```bash
gh pr create --draft --title '<title>' --body-file /tmp/pr-body.md
```

Update existing PRs with `gh api`:

```bash
gh api -X PATCH repos/{owner}/{repo}/pulls/PR_NUMBER \
  -f title='<title>' \
  -F body=@/tmp/pr-body.md
```

Refresh the title and body when follow-up commits materially change scope,
approach, breaking behavior, risk, migration, or review expectations. Skip
typo-only, formatting-only, and rename-only follow-ups.
