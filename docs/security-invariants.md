# Security invariants

Use this checklist when reviewing extension runtime behavior, tool schemas, network access, filesystem access, credentials, caching, or output rendering.

## Repository-wide

- Treat tool arguments, repository files, nested instructions, remote content, redirects, snippets, error bodies, and model-visible output as untrusted data.
- Validate inputs at the boundary and pass values as data; never construct shell commands from untrusted strings.
- Keep tool output within explicit byte and line limits and report truncation or continuation details.
- Propagate cancellation and failures without returning partial work as success.
- Keep temporary files private, bounded, and removed on success, failure, cancellation, and session shutdown.
- Keep Pi-provided packages in `peerDependencies` with `"*"` ranges and restrict published files with each package's `files` allowlist.
- Add boundary and failure-path tests whenever a trust boundary changes.

## Git automation

Extensions that execute Git must require project trust before invoking repository-controlled configuration, remotes, or hooks; pin a canonical worktree root and exact refs before mutation; pass untrusted repository data only as fixed arguments; bound all parsed and reported output; and fail closed when inspection or state verification is uncertain. Git synchronization checks may fetch, but must not automatically choose a merge, rebase, reset, or pull strategy for a behind or diverged branch.

Follow the shared inspection, mutation, reporting, and testing practices in [`git.md`](git.md).

## Filesystem and project context

- `pi-nested-agent-md` must reject paths outside the project, including traversal and symlink escapes; preserve outermost-to-innermost instruction ordering, deduplication, and bounded reinjection after context resets.

## Web fetch

Changes to `pi-web-fetch` must preserve:

- HTTP(S)-only URLs, rejection of embedded credentials, and redaction of common credential-bearing query parameters from displayed URLs and result metadata;
- DNS validation that rejects local, private, and reserved targets;
- validation of every redirect target;
- redirect, timeout, extraction-time, and response-size bounds;
- an allowlist of textual response media types;
- byte-bounded caching, safe request coalescing, and per-caller cancellation; and
- untrusted-content wrappers and closing-tag escaping.

Keep the complete validate–resolve–pin–redirect boundary inside `pi-web-fetch` until either a second arbitrary-URL consumer appears or equivalent DNS-pinning logic is duplicated elsewhere. At that point, extract the whole boundary rather than sharing only part of the policy or transport flow.

## Web search

Changes to `pi-web-search` must preserve:

- API-key secrecy and omission of credentials from tool output and errors;
- request timeouts, bounded provider responses, and bounded rendered output;
- byte-bounded caching, safe request coalescing, and per-caller cancellation;
- private temporary files and cleanup on every exit path; and
- untrusted-content wrappers for snippets and extracted context.

Run the complete validation command (`vp run validate`) before proposing a security-sensitive change.
