---
name: tech-debt
description: Use this skill when auditing technical debt, assessing code health, deciding what to refactor, or prioritizing a maintenance backlog. Categorize code, architecture, test, dependency, documentation, and infrastructure debt, score impact, risk, and effort, and produce a phased remediation plan.
---

# Tech Debt Management

Build an evidence-based backlog of maintainability risks and opportunities; do not label unfamiliar or merely disliked code as debt without explaining its cost.

## Workflow

1. Clarify the audit scope, goals, constraints, and time horizon. Inspect relevant code, tests, dependency/configuration files, operational docs, and recent history or incidents when available.
2. Record each candidate with a specific location or artifact, observed condition, current/potential consequence, and evidence. Separate confirmed problems from hypotheses and identify missing evidence.
3. Categorize candidates: code, architecture, test, dependency, documentation, or infrastructure. Describe overlap once and link related items rather than double-counting.
4. Estimate impact, risk, and effort using the anchors below. Explain unusual scores and note dependencies or uncertainty; do not imply numeric precision.
5. Prioritize changes that reduce material risk or recurring friction. Suggest a bounded first step, success/exit criteria, and a suitable phase that can fit alongside feature work.

## Relative scoring (1–5)

- **Impact:** 1 = localized inconvenience; 3 = recurring team or user cost; 5 = major reliability, security, delivery, or business impact.
- **Risk:** 1 = unlikely/low consequence; 3 = plausible regression, outage, or maintenance failure; 5 = credible severe or broad harm.
- **Effort:** 1 = small, isolated change; 3 = several files or coordinated tests; 5 = broad redesign/migration or substantial unknowns.

Optional ranking score: `(impact + risk) × (6 − effort)`. Use it as a discussion aid, not an objective measure; urgency, dependencies, and confidence can override the ranking.

## Categories

| Type           | Examples to investigate                           | Typical consequence               |
| -------------- | ------------------------------------------------- | --------------------------------- |
| Code           | Duplication, brittle coupling, unclear invariants | Defects, slow changes             |
| Architecture   | Misplaced boundaries, unsafe data flows           | Scaling or change constraints     |
| Test           | Missing critical-path checks, flaky suites        | Regressions, slow feedback        |
| Dependency     | Unsupported or risky dependency versions          | Security, compatibility           |
| Documentation  | Stale procedures or undocumented constraints      | Onboarding and operational errors |
| Infrastructure | Manual recovery/deployments, missing safeguards   | Incidents and recovery time       |

## Output

Present a short summary, then prioritized items with evidence/location, category, consequence, impact/risk/effort and confidence, recommended next step, dependencies, and completion criteria. Group into practical phases. Avoid unsupported claims about coverage, vulnerabilities, or dependency status; state what needs verification.
