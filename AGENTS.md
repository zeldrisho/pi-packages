# Agent Instructions

## Commands

| Task                                 | Command                              |
| ------------------------------------ | ------------------------------------ |
| Install dependencies                 | `vp install`                         |
| Complete validation                  | `vp run validate`                    |
| Check formatting, linting, and types | `vp check`                           |
| Fix check failures                   | `vp check --fix`                     |
| Run all tests                        | `vp test`                            |
| Run one package's tests              | `vp run '@zeldrisho/<package>#test'` |
| Inspect every npm tarball            | `vp run pack:dry-run`                |

## Sources of Truth

| Need                       | Source                                                                  |
| -------------------------- | ----------------------------------------------------------------------- |
| Package catalog            | `README.md`                                                             |
| Development                | `docs/development.md`                                                   |
| Security invariants        | `docs/security-invariants.md`                                           |
| Package behavior and setup | `packages/*/README.md`                                                  |
| Release process            | `docs/releases.md`                                                      |
| Release configuration      | `cliff.toml`, `scripts/release.ts`, and `.github/workflows/release.yml` |

## Package Constraints

- Keep each extension independent in `packages/<name>/`.
- Keep runtime TypeScript in `src/` and tests in `tests/`.
- Pi loads TypeScript directly; do not add a JavaScript build step.
- Keep npm contents allowlisted with each package's `files` field.
- Do not publish tests, TypeScript configuration, Vite configuration, or workspace files.
- Put Pi-provided imports in `peerDependencies` with `"*"` ranges; put other runtime libraries in `dependencies`.

## Git Workflow

- Before starting work, fetch and prune remote refs, reconcile local and remote state, and remove completed local branches.
- Keep only `main` and one active work branch locally; do not create a second work branch.
- Rebase the active work branch onto its target branch; do not merge the target branch into it.
- Never rewrite commits that are merged, tagged, released, or published.

## Pull Requests and Releases

- When asked to push changes, push the work branch and create a pull request.
- Agents must never merge pull requests; leave merging to the user.
- Do not hand-edit the `git-cliff/release` branch or generated release artifacts to force a release through checks.
- Do not publish npm packages, create tags or GitHub releases, or approve protected-environment deployments unless explicitly requested for the specific package and version.
- Let the git-cliff workflow manage versions; keep package manifests, component tags, GitHub releases, and npm synchronized.
