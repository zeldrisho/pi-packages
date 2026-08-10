# Technical debt remediation plan

This plan turns the repository-wide technical debt audit into work that can be completed alongside feature development. It prioritizes release safety, dependency governance, and maintenance of security-sensitive boundaries without requiring a rewrite.

Use the repository commands and conventions in [development.md](development.md), preserve the invariants in [security-invariants.md](security-invariants.md), and follow [release.md](release.md) for publication changes.

## Historical baseline

At the time of the 2026-08-03 audit:

- `vp run validate` passes;
- all 137 tests pass;
- line coverage is 94.38% and branch coverage is 81.05%;
- package contracts, tarball inspection, and packaged-extension smoke tests pass; and
- the dependency audit reports no known vulnerabilities.

At the 2026-08-05 follow-up audit (PR #36):

- `vp run validate` passes: 266 tests across 23 files pass;
- line coverage is 94.77%, statements 91.35%, branches 82.94%, and functions 94.11%;
- package contracts, tarball inspection, and packaged-extension smoke tests pass; and
- GitHub advisory scanning surfaced six transitive advisories — five in `undici` (pinned at `8.5.0` by `@earendil-works/pi-coding-agent` even at its latest `0.83.0`) and one in `brace-expansion` (arriving via `minimatch`) — resolved in PR #36 with repo-level overrides (`undici 8.9.0`, `brace-expansion 5.0.9`); one moderate dev-only advisory remains (`postcss` via the Vite/Vitest toolchain, GHSA-fxqj-rqcc-2cmp).

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
|       12 | Manage the dependency-override lifecycle                          | Dependency/documentation  |      2 |    4 |      1 |    30 |
|       13 | Gate CI on dependency audits                                      | Infrastructure/dependency |      3 |    3 |      2 |    24 |
|       14 | Refresh the Pi catalog on a cadence                               | Dependency                |      2 |    3 |      3 |    15 |
|       15 | Document schema-level limit enforcement                           | Documentation             |      1 |    2 |      1 |    15 |

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

**Done when:** `ensure-github-release` leaves no temporary release-notes directory behind.

### 12. Manage the dependency-override lifecycle

The 2026-08-05 audit fixed six transitive advisories with repo-level overrides because upstream still ships vulnerable pins: `undici` is pinned at `8.5.0` by `@earendil-works/pi-coding-agent` (even at its latest `0.83.0`; GHSA-4cwx-7wf7-3272, GHSA-8xcm-r25x-g524, GHSA-v3r7-h72x-cjcm, GHSA-jr45-8vmc-qm54, GHSA-m8rv-5g2x-5cg5), and `brace-expansion` arrives via `minimatch` below the fixed `5.0.9` (GHSA-rgw5-rvv9-x895).

Overrides are forks of upstream dependency decisions. Without a removal condition they persist silently, force versions across every future upstream bump, and can break installs if upstream moves to a semver-incompatible release, because pnpm overrides ignore upstream ranges.

- [x] Annotate each override in `pnpm-workspace.yaml` with the advisory IDs and the removal condition (for example “drop when `pi-coding-agent` repins `undici` ≥ `8.9.0`”).
- [x] File a tracking issue listing both overrides and link it from the override comment block.
- [x] Re-check the removal conditions on every catalog or lockfile bump and drop the satisfied override in the same change.
- [x] Extend `scripts/repository-contract-test.ts` (or a small script) to fail when an overridden package is no longer present in the dependency graph, signaling a removable override.

**Done when:** every override states why it exists and when it can be removed, a tracking issue links them, and a check surfaces stale overrides.

### 13. Gate CI on dependency audits

GitHub advisory scanning surfaces alerts asynchronously as PR comments; the build itself never failed on the six open advisories. A local audit gate turns that into a deterministic failure. This does not reintroduce update automation — item 1's manual-review decision stands; this adds detection only.

- [x] Add `pnpm audit --audit-level high` to `ci.yml` after `vp install`.
- [x] Define a policy for dev-only advisories: the current `postcss ≤ 8.5.22` finding (GHSA-fxqj-rqcc-2cmp, via the Vite/Vitest toolchain) may be allowlisted only with justification and a tracking issue, or resolved by bumping the toolchain.
- [x] Keep production-path advisories unallowlisted so the item-12 overrides remain the only escape hatch for transitive runtime dependencies.

**Done when:** a new high-severity advisory fails the build, and the allowlist contains only documented dev-only entries.

### 15. Document schema-level limit enforcement

PR #36 flattened the web-search tool schema from an `Intersect`/`Union` to a provider-compatible object schema because the provider rejects `allOf`/`anyOf`. `mode: "context"` now accepts up to the web-mode query length (500) at the schema level; the tighter 400-character context limit is enforced at runtime and covered by `schema-rendering.test.ts`. The behavior change is easy to rediscover as a bug.

- [x] Add one sentence to `packages/pi-web-search/README.md` stating that context-mode queries are validated at runtime, not in the tool schema, because the provider rejects union schemas.
- [x] Note the runtime-enforcement test in the schema contract test so the coupling is discoverable.

**Done when:** the README states where each query limit is enforced.

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

### 14. Refresh the Pi catalog on a cadence

The catalog pins `@earendil-works/*` at `^0.80.10` (a 0.x caret range, so updates to `0.83.0` are manual). The `0.83.0` release still pins vulnerable `undici@8.5.0`, so this is not a security fix today — but staying behind keeps the item-12 overrides in place longer and delays surfacing upstream dependency fixes.

- [x] Bump the catalog to the latest upstream release (currently `0.83.0`) in a small, separately reviewed change per item 7.
- [x] On each bump, re-check the item-12 removal conditions and drop any satisfied override in the same change.
- [x] Establish a cadence: at minimum once per release cycle, or a scheduled lane if the repository grows.

**Done when:** the catalog tracks the latest upstream release with a defined cadence and each bump re-evaluates the overrides.

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
