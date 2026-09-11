# Agent Instructions

## Package Manager

- Use **Vite+** (`vp install`) with the pnpm workspace and lockfile.
- Use `vp run <name>` for project scripts; `vp <name>` invokes a built-in command.
- Use Node.js 24.10.0 or newer.

## Commands

| Task                              | Command                              |
| --------------------------------- | ------------------------------------ |
| Run one test file                 | `vp test <path-to-test>`             |
| Run one package's tests           | `vp run '@zeldrisho/<package>#test'` |
| Lint one file                     | `vp lint <path-to-file>`             |
| Format one file                   | `vp fmt <path-to-file> --write`      |
| Type-check workspace              | `vp run typecheck`                   |
| Complete validation before review | `vp run validate`                    |
| Normalize changelogs              | `vp run format:changelog`            |
| Sync shared web modules           | `vp run sync:web-modules`            |

## Key Conventions

- Edit shared `cache.ts`, `inflight.ts`, and `render.ts` in `packages/pi-web-fetch/src/`, then run `vp run sync:web-modules` to update `pi-web-search`.
- Read `docs/development.md` before runtime or dependency changes, especially its security and regression requirements.
- Read `docs/architecture.md` before changing package boundaries, network acquisition, caching, or derived views.
- Follow `docs/release.md` before version bumps, changelog edits, tags, or publishing; pushing a component tag publishes automatically.

## External References

| Need                                            | File                                  |
| ----------------------------------------------- | ------------------------------------- |
| Package catalog                                 | `README.md`                           |
| Setup, conventions, security, dependency policy | `docs/development.md`                 |
| Architecture and network trust boundaries       | `docs/architecture.md`                |
| Git automation policy                           | `docs/git.md`                         |
| Toolchain guidance                              | `docs/vite-plus.md`                   |
| Release process                                 | `docs/release.md`                     |
| Gate behavior and configuration                 | `packages/pi-gate/README.md`          |
| Gate configuration schema                       | `packages/pi-gate/config.schema.json` |
| Fetch behavior and setup                        | `packages/pi-web-fetch/README.md`     |
| Search behavior and setup                       | `packages/pi-web-search/README.md`    |
| CI checks                                       | `.github/workflows/ci.yml`            |
