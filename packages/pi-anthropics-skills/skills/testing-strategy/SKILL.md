---
name: testing-strategy
description: Use this skill when designing a test strategy or test plan, deciding what tests to write, evaluating coverage, or choosing test architecture. Balance unit, integration, and end-to-end coverage around critical paths, error handling, edge cases, security boundaries, and data integrity, and identify testing gaps.
---

# Testing Strategy

Produce a risk-based plan grounded in the codebase and the team's ability to run and maintain tests.

## Workflow

1. Clarify the change, user-visible behavior, critical data, and constraints (runtime, CI time, test environment).
2. Inspect implementation, existing tests, test commands/configuration, and recent relevant failures if available. Identify what is already covered before proposing additions.
3. Trace critical paths and trust boundaries. Include expected behavior, invalid inputs, failure paths, and state/data integrity.
4. Choose the smallest test level that gives meaningful confidence: unit for isolated logic, integration for component boundaries, end-to-end for essential user journeys. Add contract tests where independently deployed consumers depend on an interface.
5. Prioritize cases by impact and likelihood; note test data/setup, dependencies, and whether each case is automated, manual, or currently blocked.
6. Recommend coverage targets only when tied to a risk or meaningful behavior; do not prescribe a universal percentage.

## Coverage considerations

- APIs: business rules, authorization, request/response contracts, error mapping.
- Data workflows: validation, transformations, idempotency, partial failure, recovery.
- Frontends: key interactions, accessibility, loading/error states; use visual tests only where visual regressions matter.
- Infrastructure: deployment/configuration smoke tests and resilience/load tests when justified by impact.
- Scripts and migrations: include tests when they transform important data, change permissions, or can cause costly/irreversible effects. Do not exclude work just because it is a one-off.

Avoid low-value tests that only restate implementation or exercise trivial framework behavior. Prefer observable assertions over implementation details.

## Output

Give a prioritized plan with behavior/risk, test level, concrete cases, existing coverage/gaps, and execution constraints. Distinguish recommended tests from optional follow-up work; do not invent coverage claims or targets without repository evidence.
