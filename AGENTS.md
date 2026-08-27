# Agent Instructions

## Package Manager

- Use **vp**: `vp install`

## Project Layout

| Path               | Purpose                                                       |
| ------------------ | ------------------------------------------------------------- |
| `packages/<name>/` | Independently published extensions (`src/` runtime, `tests/`) |
| `scripts/`         | Changelog, release, and shared-module tooling                 |
| `tests/`           | Repository contracts, tooling tests, and package smoke tests  |

## Commands

| Task                    | Command                              |
| ----------------------- | ------------------------------------ |
| Run one test file       | `vp test <path-to-test>`             |
| Run one package's tests | `vp run '@zeldrisho/<package>#test'` |
| Fix formatting and lint | `vp check --fix`                     |
| Complete validation     | `vp run validate`                    |
| Normalize changelogs    | `vp run format:changelog`            |
| Sync shared web modules | `vp run sync:web-modules`            |

## Key Conventions

- Edit shared web modules in `pi-web-fetch`, then run `vp run sync:web-modules`.
- Write changelog entries, then run `vp run format:changelog`.

## External References

| Need                        | File                          |
| --------------------------- | ----------------------------- |
| Package catalog             | `README.md`                   |
| Development and conventions | `docs/development.md`         |
| Architecture                | `docs/architecture.md`        |
| Security invariants         | `docs/security-invariants.md` |
| Git automation              | `docs/git.md`                 |
| Package behavior and setup  | `packages/*/README.md`        |
| Releases                    | `docs/release.md`             |
