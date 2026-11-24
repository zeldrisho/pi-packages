---
name: commit
description: Use for requests to commit changes or draft a commit message. Defaults to Conventional Commits.
---

# Conventional Commits

## Before Committing

Check the repository's commit conventions and branch rules. Follow them where
specified; otherwise use the defaults below.

```bash
git branch --show-current
```

If the branch is `main` or `master`, prefer a feature branch unless the
repository rules or the user say otherwise.

Commit one coherent, independently reviewable change at a time.

## Message Rules

Use:

```text
<type>(<scope>): <subject>

<optional body>

<optional footer>
```

- Scope is optional. Add `!` before `:` for a breaking change.
- Write the subject in imperative, present tense; omit the trailing period
  and keep it at 70 characters or fewer.
- Keep every line under 100 characters.
- Use the body only when useful. Explain what changed and why, including
  previous behavior or motivation when it helps.
- Never include customer or organization names, user emails, support ticket
  contents, secrets, or PII. Describe the technical symptom instead.

Common types: `feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `build`,
`ci`, `chore`, `style`, and `revert`.

Use `refactor` for refactoring without behavior changes and `style` for
formatting without logic changes.

## Footers

- `Fixes <issue>` closes an issue when merged.
- `Refs <issue>` links an issue without closing it.
- For breaking changes, add `BREAKING CHANGE: <impact>`.

## Creating the Commit

Use separate `-m` arguments for paragraphs and footers. Never put literal
`\n` sequences in a commit message or open an interactive editor.

```bash
git commit -m "fix(api): handle null response in user endpoint" \
  -m "Return 404 when the user API finds a deleted account." \
  -m "Fixes #123"
```
