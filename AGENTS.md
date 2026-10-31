# Agent Instructions

## Toolchain

- Use **Vite+** (`vp install`) with the pnpm workspace and lockfile.
- Use `vp run <name>` for project scripts; `vp <name>` invokes a built-in command.
- Use `vp pm <command>` for package-manager commands Vite+ does not provide; it delegates to pnpm (for example, `vp pm publish`).
- Use `fd` for file discovery.
- Use `rg` for content search.

## Commands

| Task                          | Command                              |
| ----------------------------- | ------------------------------------ |
| Run one test file             | `vp test <path-to-test>`             |
| Package tests (if defined)    | `vp run '@zeldrisho/<package>#test'` |
| Auto-fix formatting and lint  | `vp check --fix`                     |
| Complete checks before review | `vp run ready`                       |

## Rules

- Use Conventional Commits.
- Before implementing package changes, research related existing packages at `site:pi.dev/packages`.
- Keep READMEs user-guide-only; put implementation and maintenance details in `docs/`.
- Record only user-facing changes under `Unreleased` in package changelogs; run `vp run format:changelog` after edits.
- Edit shared `cache.ts`, `inflight.ts`, and `render.ts` in `packages/pi-web-fetch/src/`, then run `vp run sync:web-modules` to update `pi-web-search`.
- Read `docs/development.md` before runtime or dependency changes, especially its security and regression requirements.
- Read `docs/architecture.md` before changing package boundaries, network acquisition, caching, or derived views.
- Follow `docs/releasing.md` before version bumps, changelog edits, tags, or publishing.
- Update work branches from their target before review.

## References

| Need                                            | File                                    |
| ----------------------------------------------- | --------------------------------------- |
| Package catalog                                 | `README.md`                             |
| Setup, conventions, security, dependency policy | `docs/development.md`                   |
| Architecture and network trust boundaries       | `docs/architecture.md`                  |
| Release process                                 | `docs/releasing.md`                     |
| Package behavior, setup, and usage              | `packages/<package>/README.md`          |
| Package configuration schemas (when present)    | `packages/<package>/config.schema.json` |
| Dependency catalog and override conditions      | `pnpm-workspace.yaml`                   |
| Task definitions and test configuration         | `package.json`, `vite.config.ts`        |
| CI checks                                       | `.github/workflows/ci.yml`              |
