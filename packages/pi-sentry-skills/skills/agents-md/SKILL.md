---
name: agents-md
description: Use this skill when creating or updating AGENTS.md or other repository agent-instruction files, especially when documenting project-specific tooling, policies, or conventions.
---

# Maintaining AGENTS.md

Write only repository-specific instructions that save an agent from likely mistakes. Target under 60 lines; never exceed 100.

## Workflow

1. Inspect the target directory and its ancestors for existing `AGENTS.md` files. Read applicable instructions before editing.
2. Inspect actual evidence: lockfiles and manifests for package manager; scripts, task runners, and CI for commands; docs and policies for requirements; code and tests for conventions and generated files.
3. Choose scope: root file for repository-wide defaults; nested file only for subtree-specific rules. The nearest applicable file takes precedence for its subtree; retain non-conflicting parent guidance and remove only superseded rules.
4. Include only instructions that are actionable and not already obvious from tools/configuration. Prefer links to authoritative repository docs over copied policy.
5. Verify every referenced path and every command against repository files/configuration. Use the repository's actual package manager and test/lint commands; do not assume pnpm, npm, Vitest, ESLint, or any other tool.
6. Review the final file for duplication, contradictions, stale instructions, and line count.

## Optional structure

Use only sections supported by repository evidence:

```markdown
# Agent Instructions

## Toolchain

- Use [verified package manager/setup command].

## Commands

| Task | Command            |
| ---- | ------------------ |
| Test | [verified command] |

## Key Conventions

- [Specific, verified repository rule.]

## External References

| Need    | File            |
| ------- | --------------- |
| [Topic] | [Verified path] |
```

## Writing rules

- List exact existing docs for setup, architecture, security, release, and policy when relevant.
- Prefer the narrowest useful test/lint command; include broader commands only when no narrower command exists.
- Keep one actionable rule per bullet; use repository-relative paths.
- Omit generic quality slogans, welcome text, conclusions, and rationale unless it prevents a likely mistake.
- Do not restate formatter, linter, or type-checker configuration.
- Do not list installed skills or plugins.
- Keep generated files under their documented generation workflow.
