---
name: documentation
description: Use this skill when writing or maintaining engineering documentation such as READMEs, API references, runbooks, architecture documents, or onboarding guides for a specific audience.
---

# Technical Documentation

Create documentation that helps its intended reader complete a task accurately. Keep procedures and claims grounded in the project, not assumptions.

## Workflow

1. Identify the reader, their goal, and the document type. For a README, optimize for first successful use; for a runbook, incident recovery; for API docs, correct integration; for architecture docs, decisions and system boundaries; for onboarding, safe completion of common tasks.
2. Inspect the implementation and authoritative sources (configuration, API schemas, existing docs, tests, CI). Reuse verified commands and names; mark unresolved behavior as a question rather than guessing.
3. Lead with the information needed to act. Order steps by dependency and include prerequisites, expected results, and failure or rollback guidance when relevant.
4. Include a minimal working example for interfaces or procedures. Verify syntax, paths, options, outputs, and links against available sources; do not invent API behavior.
5. Link to the source of truth instead of duplicating policy or reference material. Keep duplicated facts minimal and clearly scoped.
6. Review for the intended reader: can they find the next action, understand terminology, and distinguish required from optional steps? Remove stale, redundant, or generic text.

## Useful content by document type

- **README:** purpose, prerequisites, quick start, configuration, common usage, and links to contribution/support guidance.
- **API reference:** authentication, request/response shapes, errors, pagination/limits where applicable, and runnable examples.
- **Runbook:** trigger/conditions, access prerequisites, ordered procedure, verification, rollback, and escalation when known.
- **Architecture:** context, goals, components/data flow, key decisions, trade-offs, and boundaries.
- **Onboarding:** environment setup, system relationships, common tasks, and verified help channels.

Adapt these lists; do not add sections that do not help the reader.
