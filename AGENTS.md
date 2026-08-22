# Agent Instructions

## Package Manager

- Use **vp**: `vp install`

## Project Layout

| Path          | Purpose                                                                                                                                                                                                                                       |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/*/` | Independently published Pi extensions — runtime code in `src/`, package tests in `tests/`.                                                                                                                                                    |
| `scripts/`    | Release tooling: `release.ts` maps a component tag to its package and reads notes from the changelog; `sync-web-modules.ts` keeps the `pi-web-fetch`/`pi-web-search` shared modules byte-for-byte identical. Invoked by the release workflow. |
| `tests/`      | Repository contracts, packaged-extension smoke tests, and automated tests (unit, cross-package contract, release automation).                                                                                                                 |

## Commands

| Task                      | Command                                        |
| ------------------------- | ---------------------------------------------- |
| Complete validation       | `vp run validate`                              |
| Fix check failures        | `vp check --fix`                               |
| Run one test file         | `vp test packages/<name>/tests/<file>.test.ts` |
| Run one package's tests   | `vp run '@zeldrisho/<package>#test'`           |
| Inspect every npm tarball | `vp run pack:dry-run`                          |
| Normalize changelog       | `vp run format:changelog`                      |
| Sync web modules          | `vp run sync:web-modules`                      |

## Key Conventions

- Write every `CHANGELOG.md` entry by hand in Keep a Changelog 2.0.0 form, then run `vp run format:changelog` to normalize the file (it rebuilds the `[Unreleased]` comparison links and the version reference block). The released version section becomes the GitHub release notes; the release workflow only reads the changelog — it never writes it.
- Before implementation, run `git fetch --prune`, inspect local and upstream state, and start from the latest target branch without discarding uncommitted work.
- Delete a completed local branch only when it is merged into its target and its upstream branch is gone.

## External References

| Need                        | File                          |
| --------------------------- | ----------------------------- |
| Package catalog             | `README.md`                   |
| Development and conventions | `docs/development.md`         |
| Architecture                | `docs/architecture.md`        |
| Security invariants         | `docs/security-invariants.md` |
| Package behavior and setup  | `packages/*/README.md`        |
| Releases                    | `docs/release.md`             |
