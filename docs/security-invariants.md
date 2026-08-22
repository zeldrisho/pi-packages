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

## Filesystem and project context

- `pi-nested-agent-md` must reject paths outside the project, including traversal and symlink escapes; preserve outermost-to-innermost instruction ordering, deduplication, and bounded reinjection after context resets.
- `pi-file-remove` must remain prompt-only and must not execute or intercept removal commands. Its `gomi` preference applies only to the user's local development machine, not CI, containers, production, or other shared or automated environments.
- `pi-file-search` must remain prompt-only and must never execute, intercept, or block discovery commands or silently broaden Pi's tool permissions.
- `pi-vite-plus` must remain prompt-only and must never intercept commands, change package-manager metadata, or run migration, install, or publish commands itself.
- `pi-cloudflare` must remain prompt-only and must not execute or intercept Cloudflare API calls. Its guidance applies only to retrieving current Workers documentation and limits.

## Web fetch

Changes to `pi-web-fetch` must preserve:

- HTTP(S)-only URLs and rejection of embedded credentials;
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

Run the complete validation command in `AGENTS.md` before proposing a security-sensitive change.
