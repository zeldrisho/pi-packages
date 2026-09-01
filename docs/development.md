# Development guide

Use this guide when changing package implementations or tests. See each package README for user-facing behavior and configuration.

## Setup

Install [Vite+](https://viteplus.dev/) and then install the workspace dependencies:

```bash
vp install
```

Set `BRAVE_SEARCH_API_KEY` only when manually exercising `pi-web-search`. Never write credentials to tracked files.

## Package conventions

Browse the [Pi package directory](https://pi.dev/packages) for examples of published Pi extensions and package conventions.

- Keep each extension independent under `packages/<name>/`.
- Put runtime TypeScript in `src/` and tests in `tests/`; Pi loads TypeScript directly, so do not add a JavaScript build step.
- Use `Type.Object()` from `typebox` for tool parameter schemas and `StringEnum` from `@earendil-works/pi-ai` for string enums.
- Keep tool output within Pi's line and byte limits.
- Treat fetched pages, search results, redirects, snippets, and error bodies as attacker-controlled input.
- Keep user-facing setup and behavior in the package README.
- Keep Pi-provided imports in `peerDependencies` with `"*"` ranges. Put other runtime libraries in `dependencies`.
- Keep each package's npm contents restricted by its `files` allowlist.

## Security invariants

Read [`security-invariants.md`](security-invariants.md) before changing extension runtime behavior, tool schemas, network access, filesystem access, credentials, caching, or output rendering. Follow [`git.md`](git.md) when an extension inspects or mutates a Git repository.

## Verification

Run the complete validation suite:

```bash
vp run validate
```

The shared task runs formatting, linting, type checking, coverage tests, repository contract tests, tarball inspection, and packaged extension smoke tests. Every dry-run tarball must contain only `CHANGELOG.md`, `LICENSE`, `package.json`, `README.md`, and the package's runtime files under `src/`. The packaged smoke test installs each tarball in an isolated fixture and loads it through Pi's extension loader.

The tests use deterministic local fixtures and mocked Brave responses. Manually verify behavior affected by a change:

- `pi-web-search`: missing-key errors, web/context modes, filters, byte-bounded caching, request coalescing, cancellation, truncation, and temporary-file cleanup;
- `pi-web-fetch`: supported formats, redirects, blocked local/private targets, oversized responses, caching, request coalescing, and offset continuation; and
- `pi-nested-agent-md`: ancestor ordering, direct reads, deduplication, paths outside the working directory, output bounds, and reinjection after compaction.

For extraction changes, run the opt-in live quality corpus separately from deterministic validation:

```bash
vp run benchmark:web-fetch-extraction
```

The benchmark checks stable content markers and minimum extracted sizes while reporting extractor choice and latency. Use `-- --filter <category>` for a subset or `-- --json` for machine-readable output. Network or upstream-content failures make the benchmark fail, so it is diagnostic rather than part of `validate`.

Before changing focused-section ranking, record the deterministic heading, phrase, and stemming baseline:

```bash
vp run benchmark:web-fetch-focus
```

A known miss is useful baseline evidence; do not tune ranking from one fixture or silently redefine expected markers to make the benchmark pass.

To load a local package in an isolated Pi session, run `pi -e ./packages/<name>` and disable globally installed extensions as needed so they cannot interfere with manual verification.

## Regression and review discipline

Turn production failures and fixed issues into deterministic regression fixtures, retaining the issue
identifier in the test name or fixture when it helps future diagnosis. For stateful operations, cover
both the expected path and state that moves, disappears, times out, is killed, or is refused between
inspection and mutation. For extraction and ranking, preserve representative malformed, noisy, and
false-positive inputs; use the live corpus to evaluate quality changes, not as a replacement for
repeatable tests.

Before review, inspect the final diff for behavior beyond the requested scope, especially implicit
mutation, forceful fallbacks, new network paths, cache-semantic changes, or hidden output growth. Run
package-focused tests while iterating, then `vp check --fix`, any required normalization task, and
`vp run validate` once code and documentation are final.

## Dependency reviews

Dependency updates are opened manually. Inspect upstream release notes and the lockfile, confirm GitHub
Actions use reviewed semantic major tags, and run `vp run validate`. Review Pi ecosystem packages
together when they share an API release train. Keep Typebox, Vite+, TypeScript, and major toolchain
updates separate; never combine a TypeScript major migration with routine dependency updates.

Refresh the `@earendil-works/*` catalog at least once per release cycle so the workspace tracks the
latest upstream Pi release. On every catalog or lockfile bump, re-check the override removal
conditions annotated in `pnpm-workspace.yaml` (tracked in issue
[#37](https://github.com/zeldrisho/pi-packages/issues/37)) and drop any satisfied override in the same
change; `tests/repository-contract.test.ts` fails when an overridden package disappears from the
dependency graph.

CI runs `vp pm audit -- --audit-level high` on every pull request (`.github/workflows/ci.yml`).
Production-path advisories are never allowlisted; the documented overrides in `pnpm-workspace.yaml`
remain the only escape hatch for transitive runtime dependencies. Dev-only advisories are resolved by
updating the toolchain or lockfile; if one cannot be resolved, it may be allowlisted in the audit
command only with justification and a tracking issue.

Before a Pi catalog bump, verify wildcard peer compatibility against the latest Pi APIs: run
`PI_SMOKE_DEPENDENCIES=latest vp run test:packages` (or `vp run test:packages` alone to smoke-test
against the locked workspace resolution) while retaining the locked Typebox version, so wildcard Pi
peer incompatibilities are caught before the lockfile is updated.
