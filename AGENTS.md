# Agent Instructions

## Commands

| Task                      | Command                              |
| ------------------------- | ------------------------------------ |
| Complete validation       | `vp run validate`                    |
| Fix check failures        | `vp check --fix`                     |
| Run one package's tests   | `vp run '@zeldrisho/<package>#test'` |
| Inspect every npm tarball | `vp run pack:dry-run`                |

## Sources of Truth

| Need                        | Source                                                                  |
| --------------------------- | ----------------------------------------------------------------------- |
| Package catalog             | `README.md`                                                             |
| Development and conventions | `docs/development.md`                                                   |
| Security invariants         | `docs/security-invariants.md`                                           |
| Package behavior and setup  | `packages/*/README.md`                                                  |
| Releases                    | `docs/releases.md`                                                      |
| Release configuration       | `cliff.toml`, `scripts/release.ts`, and `.github/workflows/release.yml` |

## Git Workflow

- Before starting work, fetch and prune remote refs, reconcile local and remote state, and remove completed local branches.
- Keep only `main` and one active work branch locally; do not create a second work branch.
- Rebase the active work branch onto its target branch; do not merge the target branch into it.
- Never rewrite commits that are merged, tagged, released, or published.
- When asked to push, push the work branch and create a pull request; never merge it.
