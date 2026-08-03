# Technical debt remediation plan

This plan turns the repository-wide technical debt audit into work that can be completed alongside feature development. It prioritizes release safety, dependency governance, and maintenance of security-sensitive boundaries without requiring a rewrite.

Use the repository commands and conventions in [development.md](development.md), preserve the invariants in [security-invariants.md](security-invariants.md), and follow [releases.md](releases.md) for publication changes.

## Historical baseline

At the time of the 2026-08-03 audit:

- `vp run validate` passes;
- all 137 tests pass;
- line coverage is 94.38% and branch coverage is 81.05%;
- package contracts, tarball inspection, and packaged-extension smoke tests pass; and
- the dependency audit reports no known vulnerabilities.

The repository is healthy. The work below is preventative and should normally consume 15–20% of maintenance capacity rather than block feature delivery.

## Prioritization

Priority is calculated as `(Impact + Risk) × (6 − Effort)`, with each input scored from 1 to 5. Lower-effort work receives a higher score.

| Priority | Item                                                              | Category                  | Impact | Risk | Effort | Score |
| -------: | ----------------------------------------------------------------- | ------------------------- | -----: | ---: | -----: | ----: |
|        1 | Standardize GitHub Actions and dependency review                  | Infrastructure/dependency |      3 |    5 |      2 |    32 |
|        2 | Consolidate duplicated cancellation logic                         | Code                      |      2 |    4 |      1 |    30 |
|        3 | Make limits and defaults single-source                            | Code/configuration        |      3 |    3 |      2 |    24 |
|        4 | Make the web-fetch network policy maintainable                    | Security/code             |      3 |    5 |      3 |    24 |
|        5 | Test against locked and latest Pi APIs                            | Dependency/test           |      3 |    4 |      3 |    21 |
|        6 | Document complex architecture and data flows                      | Documentation             |      2 |    3 |      2 |    20 |
|        7 | Add characterization tests for release automation                 | Test/infrastructure       |      4 |    5 |      4 |    18 |
|        8 | Split oversized integration test files                            | Test                      |      3 |    2 |      3 |    15 |
|        9 | Clean release temporary directories                               | Code                      |      1 |    2 |      1 |    15 |
|       10 | Detect drift in repeated package configuration                    | Configuration             |      2 |    2 |      3 |    12 |
|       11 | Reassess synchronized web modules when they gain another consumer | Architecture              |      2 |    3 |      4 |    10 |

## Phase 1: quick safety improvements

Complete these as small, independent pull requests over the next one or two feature cycles.

### 1. Standardize Actions and dependency review

Dependency update automation was deliberately superseded in favor of manual updates.

- [x] Use reviewed semantic major tags for third-party actions in `.github/workflows/`.
- [x] Upgrade checkout steps to `actions/checkout@v7`.
- [x] Keep dependency updates manual; do not add Dependabot or Renovate configuration.
- [x] Review related Pi ecosystem updates together while keeping major toolchain upgrades separate.
- [x] Document the expected review process for dependency updates.

**Done when:** workflows consistently use approved semantic major tags, dependency updates follow the documented manual review process, and `vp run validate` passes.

### 2. Consolidate cancellation logic

The same `awaitWithAbort` behavior currently appears in `packages/pi-web-fetch/src/fetch.ts` and `packages/pi-web-fetch/src/network-redirects.ts`.

- [x] Extract a package-local cancellation helper.
- [x] Preserve timeout and caller-cancellation error semantics.
- [x] Add focused tests for already-aborted signals, late settlement, rejection, and listener cleanup.

**Done when:** only one implementation remains and existing timeout, redirect, extraction, and cancellation tests pass unchanged.

### 3. Centralize limits and defaults

- [x] Define fetch defaults and bounds once and consume them from both the schema and runtime.
- [x] Define search query and result limits once and consume them from schema, runtime, and Brave request code.
- [x] Derive smoke-test Pi dependency versions from workspace configuration or installed resolution instead of duplicating them in `scripts/package-smoke-test.ts`.
- [x] Add contract tests for values whose duplication cannot be removed.

**Done when:** changing a limit or locked Pi version requires one intentional source change, plus any user-facing documentation update.

### 4. Clean release temporary directories

- [x] Wrap the temporary notes directory in `scripts/release.ts` in `try/finally` cleanup.
- [x] Verify cleanup after both successful and failed GitHub release creation.

**Done when:** `ensure-github-release` leaves no `git-cliff-release-*` directory behind.

## Phase 2: strengthen critical boundaries

Schedule this work after Phase 1, reserving maintenance capacity in each feature cycle.

### 5. Characterize release automation

Refactor command execution only as much as needed to test behavior without live npm or GitHub operations.

- [x] Test component-tag ordering and manifest/tag consistency.
- [x] Test releasable commits, documentation-only commits, and breaking changes.
- [x] Test partial-release recovery for missing tags, GitHub releases, and npm versions.
- [x] Test npm and GitHub error classification.
- [x] Test invalid package paths and malformed external command output.
- [x] Test generated versions, changelogs, and release pull-request bodies.
- [x] Use temporary Git repositories and injected command runners rather than live services.

**Done when:** the important state transitions in `scripts/release.ts` are deterministic under test and the live workflow remains retry-safe.

### 6. Maintain the network policy systematically

The address policy in `packages/pi-web-fetch/src/network-policy.ts` is a security boundary. Do not weaken DNS validation, address pinning, or redirect revalidation while restructuring it.

- [x] Document the authoritative registry sources and the date or version reviewed.
- [x] Convert address expectations into table-driven boundary tests.
- [x] Cover the first and last address around each blocked range where practical.
- [x] Establish a periodic review or safe fixture-generation process.
- [x] Keep the complete validate–resolve–pin–redirect boundary inside `pi-web-fetch` as required by [security-invariants.md](security-invariants.md).

**Done when:** reviewers can establish why every range is present and tests detect accidental gaps or boundary changes.

### 7. Add Pi compatibility testing

Packages intentionally declare Pi-provided packages as `"*"` peer dependencies, so compatibility needs active verification.

- [x] Add a smoke-test matrix for the locked workspace Pi version and the latest supported Pi release.
- [x] Run the latest-version lane on a schedule if it would make normal pull requests unstable.
- [x] Update the Pi catalog in small, separately reviewed changes.
- [x] Update Typebox and Vite+ independently from any TypeScript major migration.
- [x] Treat TypeScript 7 as a dedicated migration with explicit compatibility validation.

**Done when:** peer compatibility failures are discovered before users encounter them, without sacrificing deterministic validation against the lockfile.

## Phase 3: ongoing maintainability

Apply a touch-it rule: complete the relevant item when feature work already modifies that area.

### 8. Split large tests by concern

- [x] Split `packages/pi-web-fetch/tests/index.test.ts` into network policy, redirects, transport, cancellation, caching, and service-level suites.
- [x] Split `packages/pi-web-search/tests/index.test.ts` into schema/rendering, provider transport, context formatting, caching/coalescing, truncation, and lifecycle suites.
- [x] Share only stable test harnesses; keep security-boundary fixtures explicit.
- [x] Preserve or improve coverage and test execution time.

### 9. Add architecture documentation

- [x] Create `docs/architecture.md` rather than expanding this plan. It covers:
  - web-fetch validation, DNS resolution, address pinning, redirects, extraction, caching, and continuation;
  - web-search provider requests, coalescing, truncation, temporary files, and shutdown cleanup;
  - release planning, versioning, tagging, GitHub releases, and npm publication; and
  - package independence and the reasons for intentional source duplication.

Link to existing documentation instead of copying setup, release, or security instructions.

### 10. Detect package-configuration drift

- [x] Extend `scripts/repository-contract-test.ts` to verify intentionally uniform scripts, TypeScript configuration, engine constraints, file allowlists, and Pi extension entries.
- [x] Keep package manifests independently publishable.
- [x] Avoid manifest generation unless package growth makes the maintenance benefit clear.

### 11. Keep synchronized web modules as accepted debt

The following files are intentionally byte-for-byte synchronized between `pi-web-fetch` and `pi-web-search`:

- `cache.ts`
- `inflight.ts`
- `render.ts`

The repository contract already controls this debt. Do not extract a shared package solely to remove duplication. Reconsider extraction only when another consumer appears or synchronized changes become materially burdensome.

## Working agreement

- Prefer one debt item per pull request unless a feature change naturally owns it.
- Run `vp run validate` before proposing completion.
- Add boundary and failure-path tests whenever trust-boundary behavior changes.
- Update this plan when an item is completed, superseded, or deliberately deferred.
- Record significant architectural choices in an ADR if they introduce a new package boundary or change a security invariant.
