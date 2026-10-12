# Agent Instructions

## Toolchain

- Use **Vite+** (`vp install`) with the pnpm workspace and lockfile.
- Use `vp run <name>` for project scripts; `vp <name>` invokes a built-in command.
- Use `fd` for file discovery.

## Commands

| Task                          | Command                              |
| ----------------------------- | ------------------------------------ |
| Run one test file             | `vp test <path-to-test>`             |
| Run one package's tests       | `vp run '@zeldrisho/<package>#test'` |
| Auto-fix formatting and lint  | `vp check --fix`                     |
| Complete checks before review | `vp run ready`                       |
| Normalize changelogs          | `vp run format:changelog`            |
| Sync shared web modules       | `vp run sync:web-modules`            |

## Key Conventions

- Edit shared `cache.ts`, `inflight.ts`, and `render.ts` in `packages/pi-web-fetch/src/`, then run `vp run sync:web-modules` to update `pi-web-search`.
- Read `docs/development.md` before runtime or dependency changes, especially its security and regression requirements.
- Read `docs/architecture.md` before changing package boundaries, network acquisition, caching, or derived views.
- Follow `docs/release.md` before version bumps, changelog edits, tags, or publishing.
- After each Pi package change, update its `CHANGELOG.md` under `Unreleased` if the change is notable to users, then run `vp run format:changelog`.
- Update work branches from their target before review.

## External References

| Need                                            | File                                    |
| ----------------------------------------------- | --------------------------------------- |
| Package catalog                                 | `README.md`                             |
| Setup, conventions, security, dependency policy | `docs/development.md`                   |
| Architecture and network trust boundaries       | `docs/architecture.md`                  |
| Release process                                 | `docs/release.md`                       |
| Package behavior, setup, and usage              | `packages/<package>/README.md`          |
| Package configuration schemas (when present)    | `packages/<package>/config.schema.json` |
| Dependency catalog and override conditions      | `pnpm-workspace.yaml`                   |
| Task definitions and test configuration         | `package.json`, `vite.config.ts`        |
| CI checks                                       | `.github/workflows/ci.yml`              |
