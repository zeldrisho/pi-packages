# Git automation

Use these guidelines when an extension inspects or mutates a Git repository. Package-specific behavior belongs in the package README; this document defines shared implementation and testing practices.

## Establish the boundary

- Require project trust before commands that can invoke repository configuration, remotes, credential helpers, or hooks.
- Require a non-bare worktree and resolve its canonical repository root before mutation.
- Run every subsequent command from the pinned root.
- Treat refs, branch names, paths, configuration, hook errors, and command output as untrusted data.

## Inspect deterministic state

- Refresh remote state before decisions that depend on it.
- Pin exact refs and commits after the refresh; do not make mutation decisions from stale state.
- Prefer bounded machine-readable Git output over human-oriented prose.
- Reject malformed, incomplete, oversized, timed-out, or killed inspection results.
- Reverify mutable refs immediately before mutation and stop if state moved or disappeared.

## Constrain mutation

- Pass untrusted values only as fixed argument-vector entries. Never construct shell commands from repository data.
- Use the least destructive native operation that satisfies the task.
- Do not add force, reset, checkout, remote mutation, or other broader behavior as a fallback.
- Treat native command refusals and hook failures as retained state, not partial success.
- Serialize same-process mutation by canonical repository root when concurrent extension calls could race.
- Document that process-local serialization does not lock out external Git processes and that repository hooks run with the user's permissions.

## Report safely

- Bound and sanitize model-visible context, notifications, and errors.
- Clearly label repository metadata as untrusted when exposing it to an agent.
- Distinguish completed mutations from unresolved items that need user review.
- Never imply that user approval overrides a safety condition still enforced by the underlying Git command.
- Deduplicate repeated visible notifications without removing hidden context the agent still needs.
- Reload project resources only when checked-out files or resource discovery inputs actually change.

## Test without external side effects

Use temporary repositories and local bare remotes. Never use the developer's repository or a network remote in automated tests.

Cover:

- trust, non-repository, and bare-repository rejection;
- machine-readable parsing and output bounds;
- refreshed target detection and exact ref pinning;
- exact non-shell mutation argv;
- native refusals, hooks, timeouts, and killed commands;
- concurrent ref movement or disappearance;
- linked worktrees and same-process serialization;
- bounded agent context and notification deduplication; and
- absence of unrelated checkout, force, remote mutation, or reload behavior.

Run package tests and the repository's complete validation task after changing Git automation.
