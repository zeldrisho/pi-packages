# Development

Use this guide when changing package implementations or tests. User-facing setup and behavior belongs in each package README; architecture invariants are in [architecture.md](architecture.md).

## Setup and commands

Install [Vite+](https://vite-plus.dev/) and workspace dependencies:

```bash
vp install
```

The current Node.js LTS release is recommended and used in CI and release workflows. Common commands:

| Task                         | Command          |
| ---------------------------- | ---------------- |
| Format, lint, type-check     | `vp check`       |
| Run one test file            | `vp test <path>` |
| Run complete checks          | `vp run ready`   |
| Show environment diagnostics | `vp env doctor`  |

Set `BRAVE_SEARCH_API_KEY` only for manually exercising `pi-web-search`; never commit credentials. Use `vp` built-in commands directly rather than adding manifest wrappers. Package `test` tasks remain available for scoped workspace runs. Inspect `package.json` and `vite.config.ts` before choosing or changing tasks.

Package READMEs are user guides. Keep implementation and maintenance notes in the shared guides under `docs/`; package-specific architecture and protocol details belong in [architecture.md](architecture.md). For provider artifact comparisons, see [compatibility.md](compatibility.md).

## Lint preset

`vite.config.ts` extends Cloudflare's Oxlint preset through Vite+ and keeps compiler diagnostics enabled. The migration leaves only rules with existing findings temporarily off. Style rules with widespread findings are deferred to avoid rewriting otherwise working code in the baseline; the remaining type-aware rules need individual review, especially at JSON boundaries and in test fixtures.

To review a deferred rule, remove its override, run `vp lint`, and commit that rule with its fixes or a documented, narrowly scoped exception. Run `vp check` and the relevant tests when changing types or behavior.

## Package conventions

- Keep each independently publishable Pi package under `packages/<name>/`. Content-only packages expose prompt templates or themes through `pi` in `package.json` and need no runtime TypeScript.
- Put runtime TypeScript in `src/` and tests in `tests/`; Pi loads TypeScript directly.
- Use `Type.Object()` from `typebox` for tool schemas and `StringEnum` from `@earendil-works/pi-ai` for string enums.
- Keep Pi imports in `peerDependencies` with `"*"` ranges unless a package requires a specific host API; put other runtime libraries in `dependencies`.
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

The live corpus is not a release gate: pages and network conditions change. A run after the Defuddle 0.19.6 update passed every entry, including the Node.js URL documentation page that an earlier run refused at the 512-element depth preflight because that page omits most `p` end tags. When a live page is refused, compare the preflight's estimate with the depth linkedom actually builds before changing either.

## Verification

Use `vp check` and focused `vp test <path>` runs during development. `vp run ready` is the complete pre-review and CI gate: it runs formatting, linting, type checking, tests, repository contracts, tarball inspection, and packaged smoke tests. The smoke test installs a temporary fixture and may require package registry access. Tarballs should contain only the package README, changelog, license, manifest, runtime `src/` files, and explicitly contracted resources such as `pi-gate`'s schema, `pi-init`'s prompt template, and `pi-catppuccin`'s themes. `pi-web-fetch` also packages generated JavaScript challenge workers and solvers under `workers/` because Node cannot strip TypeScript from worker files installed under `node_modules`; regenerate them with `vp run build:anubis-worker` and `vp run build:aws-waf-worker`.

The deterministic suites use local fixtures and mocked Brave responses. Manually verify affected behavior, including missing keys and both search modes; fetch formats, redirects, blocked targets, limits, caching, coalescing, cancellation, and continuation; and temporary-file cleanup. For manual end-to-end verification, follow [testing.md](testing.md): disable ambient discovery, load `pi-opencode-free` plus only the packages under test, and ask the user which model to use before running the check. Run the changed extension through Pi with a real tool invocation—not only a direct call to its implementation or a load-only smoke test.

For `pi-opencode-free`, `packages/pi-opencode-free/tests/pi-prompts.test.ts` checks copied compaction prompts against the installed Pi version; investigate failures after Pi upgrades instead of silently accepting drift. Transport and session changes need the package's cancellation, cleanup, and persistence tests. For `pi-web-fetch`, preserve the network trust boundary and run the relevant acquisition and failure-path tests.

Before review, inspect the final diff for unrelated behavior, new network paths, cache changes, implicit mutation, forceful fallbacks, and output growth. Run focused tests, `vp check --fix`, required normalization tasks, and finally `vp run ready`.

## Dependencies

Open dependency updates manually. Review upstream notes, lockfile changes, GitHub Action major tags, and run validation. Keep Typebox, TypeScript, and major toolchain updates separate. Keep `@types/node` aligned with the current Node.js LTS major; update it when LTS advances so type checking matches the tested runtime. After catalog or lockfile changes, check the override conditions in `pnpm-workspace.yaml` and remove satisfied overrides.

Before a catalog bump, smoke-test Pi's latest APIs with `PI_SMOKE_DEPENDENCIES=latest vp run test:packages` while retaining the locked Typebox version.
