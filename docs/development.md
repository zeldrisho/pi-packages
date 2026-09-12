# Development

Use this guide when changing package implementations or tests. User-facing setup and behavior belongs in each package README; architecture invariants are in [architecture.md](architecture.md).

## Setup and commands

Install [Vite+](https://vite-plus.dev/) and workspace dependencies:

```bash
vp install
```

Use Node.js 24.10.0 or newer. Common commands:

| Task                         | Command           |
| ---------------------------- | ----------------- |
| Format, lint, type-check     | `vp check`        |
| Run one test file            | `vp test <path>`  |
| Run complete validation      | `vp run validate` |
| Show environment diagnostics | `vp env doctor`   |

Set `BRAVE_SEARCH_API_KEY` only for manually exercising `pi-web-search`; never commit credentials. Inspect `package.json` and `vite.config.ts` before choosing or changing tasks.

## Package conventions

- Keep each independently publishable extension under `packages/<name>/`.
- Put runtime TypeScript in `src/` and tests in `tests/`; Pi loads TypeScript directly.
- Use `Type.Object()` from `typebox` for tool schemas and `StringEnum` from `@earendil-works/pi-ai` for string enums.
- Keep Pi imports in `peerDependencies` with `"*"` ranges; put other runtime libraries in `dependencies`.
- Keep npm contents restricted by each package's `files` allowlist and tool output within Pi's limits.
- Treat pages, search results, redirects, snippets, errors, and repository data as untrusted input.

## Security and regression discipline

For changes involving schemas, network or filesystem access, credentials, caching, output, or Git: validate at the boundary; never construct shell commands from untrusted strings; preserve cancellation and failure state; keep temporary files private, bounded, and removed on every exit path; and add boundary and failure-path tests. Git operations additionally require trust, a non-bare worktree, canonical-root pinning, refreshed and reverified refs, fixed argument vectors, least-destructive mutations, and no forceful fallback. Use temporary repositories and local bare remotes in tests—never the developer's repository or a network remote.

Turn production failures into deterministic regression fixtures. For stateful operations, test state changes, disappearance, timeout, termination, and refusal. Preserve malformed, noisy, and false-positive extraction cases. Before changing focused-section ranking, run:

```bash
vp run benchmark:web-fetch-focus
```

Keep source order and continuation semantics, and retain known misses as baseline evidence. The live extraction corpus is diagnostic and opt-in:

```bash
vp run benchmark:web-fetch-extraction
```

## Verification

`vp run validate` covers formatting, linting, type checking, tests, repository contracts, tarball inspection, and packaged smoke tests. Tarballs should contain only the package README, changelog, license, manifest, runtime `src/` files, and explicitly contracted metadata such as `pi-gate`'s schema.

The deterministic suites use local fixtures and mocked Brave responses. Manually verify affected behavior, including missing keys and both search modes; fetch formats, redirects, blocked targets, limits, caching, coalescing, cancellation, and continuation; and temporary-file cleanup. Load a package in an isolated session with `pi -e ./packages/<name>`.

Before review, inspect the final diff for unrelated behavior, new network paths, cache changes, implicit mutation, forceful fallbacks, and output growth. Run focused tests, `vp check --fix`, required normalization tasks, and finally `vp run validate`.

## Dependencies

Open dependency updates manually. Review upstream notes, lockfile changes, GitHub Action major tags, and run validation. Keep Typebox, Vite+, TypeScript, and major toolchain updates separate. Refresh the `@earendil-works/*` catalog at least once per release cycle; after catalog or lockfile changes, check the override conditions in `pnpm-workspace.yaml` and remove satisfied overrides. CI runs `vp pm audit -- --audit-level high`; production advisories are not allowlisted.

Before a catalog bump, smoke-test Pi's latest APIs with `PI_SMOKE_DEPENDENCIES=latest vp run test:packages` while retaining the locked Typebox version.
