# Agent Instructions

## Module layout

- `packages/*/`: independently published Pi extensions with runtime code in `src/` and package tests in `tests/`.
- `scripts/`: repository contracts, packaged-extension smoke tests, and release automation.
- `tests/`: cross-package contract tests.

## Commands

| Task                      | Command                                        |
| ------------------------- | ---------------------------------------------- |
| Complete validation       | `vp run validate`                              |
| Fix check failures        | `vp check --fix`                               |
| Run one test file         | `vp test packages/<name>/tests/<file>.test.ts` |
| Run one package's tests   | `vp run '@zeldrisho/<package>#test'`           |
| Inspect every npm tarball | `vp run pack:dry-run`                          |

## Constraints

- Keep `cache.ts`, `inflight.ts`, and `render.ts` byte-for-byte synchronized between `pi-web-fetch` and `pi-web-search`.
- Before implementation, run `git fetch --prune`, inspect local and upstream state, and start from the latest target branch without discarding uncommitted work.
- Delete a completed local branch only when it is merged into its target and its upstream branch is gone.

## References

- Package catalog: `README.md`
- Development and conventions: `docs/development.md`
- Security invariants: `docs/security-invariants.md`
- Package behavior and setup: `packages/*/README.md`
- Releases: `docs/releases.md`
- Release configuration: `cliff.toml`, `scripts/release.ts`, `.github/workflows/release.yml`
