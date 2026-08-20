# Agent Instructions

## Project Structure

- `packages/*/`: independently published Pi extensions with runtime code in `src/` and package tests in `tests/`.
- `scripts/`: release tooling (`release.ts` resolves a component tag to its package and reads release notes from the changelog; `format-changelog.ts` normalizes `CHANGELOG.md`; `sync-web-modules.ts` keeps the `pi-web-fetch`/`pi-web-search` shared modules byte-for-byte identical), invoked by the release workflow.
- `tests/`: repository contracts, packaged-extension smoke tests, and automated tests (unit, cross-package contract, and release automation tests).

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

- Keep `cache.ts`, `inflight.ts`, and `render.ts` byte-for-byte synchronized between `pi-web-fetch` and `pi-web-search`. Run `vp run sync:web-modules` to copy one side to the other (default source `pi-web-fetch`); `tests/repository-contract.test.ts` fails the build on drift, so never hand-edit only one side.
- Write every `CHANGELOG.md` entry by hand in Keep a Changelog 2.0.0 form, then run `vp run format:changelog` to normalize the file (it rebuilds the `[Unreleased]` comparison links and the version reference block). The released version section becomes the GitHub release notes; the release workflow only reads the changelog — it never writes it. See `docs/release.md` for the section format and the release procedure.
- Before implementation, run `git fetch --prune`, inspect local and upstream state, and start from the latest target branch without discarding uncommitted work.
- Delete a completed local branch only when it is merged into its target and its upstream branch is gone.

## External References

| Need                        | File                            |
| --------------------------- | ------------------------------- |
| Package catalog             | `README.md`                     |
| Development and conventions | `docs/development.md`           |
| Security invariants         | `docs/security-invariants.md`   |
| Package behavior and setup  | `packages/*/README.md`          |
| Releases                    | `docs/release.md`               |
| Release automation          | `scripts/release.ts`            |
| Changelog normalizer        | `scripts/format-changelog.ts`   |
| Web module sync             | `scripts/sync-web-modules.ts`   |
| Release workflow            | `.github/workflows/release.yml` |
