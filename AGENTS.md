# Repository Guidelines

## Project Structure

This Vite+ and pnpm workspace publishes independent Pi packages from `packages/pi-*/`. Runtime TypeScript lives in `src/`, with package tests in `tests/` and fixtures in `tests/fixtures/` where needed. Themes ship from `packages/pi-catppuccin/themes/`, skills from `packages/pi-sentry-skills/skills/`, and generated fetch workers from `packages/pi-web-fetch/workers/`. Root `tests/` covers repository contracts and packaging; `scripts/` holds maintenance tasks. Keep package READMEs user-facing and maintenance notes in `docs/`.

## Development Commands

Use the current Node.js LTS and run these from the repository root:

- `vp install` installs workspace dependencies using the pnpm lockfile.
- `vp check` checks formatting, lint, and types; `vp check --fix` applies available fixes.
- `vp test <path>` runs focused tests, e.g. `vp test packages/pi-gate/tests/rules.test.ts`.
- `vp run ready` runs the full CI gate, including coverage, tarball inspection, and packaged smoke tests. Smoke tests may require registry access.

Pi loads TypeScript directly; there is no general build step. For local Pi testing, load only the affected packages and follow `docs/testing.md` for isolation and model selection.

## Coding Style & Maintenance

Use two spaces, no tabs, and kebab-case filenames. Follow formatting and lint rules in `vite.config.ts`. Edit shared `cache.ts`, `inflight.ts`, and `render.ts` in `packages/pi-web-fetch/src/`, then run `vp run sync:web-modules`. Read `docs/development.md` before runtime or dependency changes and `docs/architecture.md` before changing network or cache behavior.

## Testing

Use Vitest and name new tests `*.test.ts`. Prefer deterministic fixtures and mocked external responses; add regression tests for boundary and failure paths. V8 coverage minimums apply per source file: 80% lines, 75% functions and statements, and 60% branches. Never commit live credentials.

## Commits & Pull Requests

Recent commits use short, action-oriented subjects, often with a type and optional scope (e.g. `fix(pi-antigravity): correct thinking lookup comment`). Update your branch from its target before review. Describe what changed and why, list verification results, and link relevant issues. Record user-facing changes under `Unreleased` in the package changelog and run `vp run format:changelog`.
