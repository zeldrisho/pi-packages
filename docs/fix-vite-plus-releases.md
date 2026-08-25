# Fix — `pi-web-fetch` `vite-plus/releases` rendering (2026-08-24)

Captures the important completed work from `docs/plan.md` and this session. `docs/plan.md` now keeps only remaining tasks.

## Problem

`web_fetch https://github.com/voidzero-dev/vite-plus/releases` in pi showed duplicated `[Latest]`/`[vite-plus v0.3.0]` links and a TUI footer crash `ERR_INVALID_URL { input: '/voidzero-dev/vite-plus/releases' }` from `extractHtmlToMarkdown` (see `/tmp/pi-clipboard-1c622b25-82ce-48f1-9153-f643d81a17c2.png`). Reproducible on `pi-web-fetch@0.6.1` + `defuddle@0.19.2`.

## Root cause

- `runDefuddle` guard only captured `defuddle`-mentioned rejections; bare-pathname `new URL('/path')` throws `TypeError: Invalid URL` without `defuddle` in stack, escaping as `unhandledRejection` to TUI.
- Detached `defuddle` throw after `await Defuddle(..., pageUrl)` with `new URL(relative, undefined)` on timer (still possible on `0.19.2`).
- GitHub releases page `nav`/`header`/`footer` wrappers survived Defuddle and produced duplicated link blocks.

## Fix (committed on `fix/pi-web-fetch-releases-guard`)

- `packages/pi-web-fetch/src/extract.ts` — `c45efc3`: widened `captureUnhandled` to also swallow `ERR_INVALID_URL` with `input` starting `/` (`isBarePathnameInvalidUrl` + `isString` guard), armed before `import("defuddle/node")`; added `assertAbsoluteHttpUrl`, `stripChromeWrappers` (`nav,header,footer,aside` removed before Defuddle), `deduplicateAdjacentLinks` (collapse adjacent identical `[Latest]` lines).
- `packages/pi-web-fetch/src/fetch.ts` — `c45efc3`: `assertAbsoluteHttpUrlForFetch(normalizeGitHubRawUrl(...))` at `fetchCompleteDocument` entry, fail closed on bare pathname.
- `packages/pi-web-fetch/package.json` + `pnpm-lock.yaml` — `c45efc3`: `defuddle ^0.19.2 -> ^0.19.3` (`sha512-5ZbO...`).
- `packages/pi-web-fetch/CHANGELOG.md` — moved fix to `## [Unreleased]` (`0.7.0` already published as `pi-web-fetch-v0.7.0` on `ab04905`).
- `c597167 chore: replace vp exec node with node` — `package.json` (`format:changelog`, `sync:web-modules`, `test:packages`), `.github/workflows/release.yml` (`node scripts/release.ts`), `docs/plan.md` repro command. `vp` already manages Node (`engines >=24.10.0` → `24.19.0`); bare `node` via `~/.vite-plus/bin/node` shim now resolves to `24.19.0`.

## Workspace Node

- `engines >=24.10.0`, `vp env current` → `24.19.0` (from `package.json`), `vp exec node --version` → `24.19.0` but `node --version` was `22.23.2` (`~/.vite-plus/js_runtime/node/22.23.2/bin` before shim, `vp env doctor` `⚠ node (not vp shim)`). Fixed session `PATH` by removing stale entry: `export PATH=$(echo $PATH | tr ':' '\n' | grep -v "js_runtime/node/22.23.2" | paste -sd: -); hash -r` → `which node` `~/.vite-plus/bin/node` `v24.19.0`. No system files changed; `~/.bashrc`/`~/.vite-plus/env` only add `~/.vite-plus/bin`.

## Verification done

- `vp test packages/pi-web-fetch/tests/extraction.test.ts` 6/6, `vp run validate` pass (114 files, 377/377 tests, contracts, pack, smoke), `node scripts/sync-web-modules.ts check` and `node tests/package-smoke-test.ts` via bare `node` 24.19.0.

## Remaining (see `docs/plan.md`)

- Manual `pi -e ./packages/pi-web-fetch -- web_fetch https://github.com/voidzero-dev/vite-plus/releases`
- Cut next release from `[Unreleased]` after manual green
