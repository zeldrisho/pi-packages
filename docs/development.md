# Development

Use this guide when changing package implementations or tests. User-facing setup and behavior belongs in each package README; architecture invariants are in [architecture.md](architecture.md).

## Setup and commands

Install [Vite+](https://vite-plus.dev/) and workspace dependencies:

```bash
vp install
```

Node.js 24.11.0 or newer is recommended. Common commands:

| Task                         | Command          |
| ---------------------------- | ---------------- |
| Format, lint, type-check     | `vp check`       |
| Run one test file            | `vp test <path>` |
| Run complete checks          | `vp run ready`   |
| Show environment diagnostics | `vp env doctor`  |

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

`vp run ready` runs formatting, linting, type checking, tests, repository contracts, tarball inspection, and packaged smoke tests. Tarballs should contain only the package README, changelog, license, manifest, runtime `src/` files, and explicitly contracted metadata such as `pi-gate`'s schema. `pi-web-fetch` also packages generated JavaScript challenge workers and solvers under `workers/` because Node cannot strip TypeScript from worker files installed under `node_modules`; regenerate them with `vp run build:anubis-worker` and `vp run build:aws-waf-worker`.

The deterministic suites use local fixtures and mocked Brave responses. Manually verify affected behavior, including missing keys and both search modes; fetch formats, redirects, blocked targets, limits, caching, coalescing, cancellation, and continuation; and temporary-file cleanup. For manual end-to-end verification, follow [testing.md](testing.md): disable ambient discovery, load `pi-opencode-free` plus only the packages under test, and ask the user which model to use before running the check. Run the changed extension through Pi with a real tool invocation—not only a direct call to its implementation or a load-only smoke test.

Before review, inspect the final diff for unrelated behavior, new network paths, cache changes, implicit mutation, forceful fallbacks, and output growth. Run focused tests, `vp check --fix`, required normalization tasks, and finally `vp run ready`.

## Dependencies

Open dependency updates manually. Review upstream notes, lockfile changes, GitHub Action major tags, and run validation. Keep Typebox, Vite+, TypeScript, and major toolchain updates separate. Keep `@types/node` on Node 24 so type checking rejects APIs unavailable in the tested runtime. After catalog or lockfile changes, check the override conditions in `pnpm-workspace.yaml` and remove satisfied overrides.

Before a catalog bump, smoke-test Pi's latest APIs with `PI_SMOKE_DEPENDENCIES=latest vp run test:packages` while retaining the locked Typebox version.
