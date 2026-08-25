# Plan — fix `pi-web-fetch` pi UI break (`https://github.com/voidzero-dev/vite-plus/releases`)

**Status:** active — do not cut `pi-web-fetch@0.7.0` until this is green. PR #72 is paused.

## Problem (screenshot `/tmp/pi-clipboard-1c622b25-82ce-48f1-9153-f643d81a17c2.png`)

`web_fetch https://github.com/voidzero-dev/vite-plus/releases` in pi renders broken:

- Content shows `## Release list` with duplicated `[Latest](…/releases/latest)` links, `[vite-plus v0.3.0: …](…/tag/v0.3.0)` twice, `[github-actions] released this 24 Aug 04:01`, then `… (76 more lines, 86 total, ctrl+o to expand)` — 86 lines but TUI footer is polluted.
- Footer overlays a Node crash: `at process.processTicksAndRejections … at async extractHtmlToMarkdown (/home/zeldrisho/.pi/agent/npm/node_modules/@zeldrisho/pi-web-fetch/src/extract{ input: '/voidzero-dev/vite-plus/releases' }` — `input` is bare pathname, not absolute URL.

Multiple prior fixes already landed (`0.6.1`: `baseUrl.href` for Defuddle, `runDefuddle` scoped `unhandledRejection` guard, `removeMalformedSchemaOrgData`, `normalizeSelectorUnsafeIds`, detached-timer `setImmediate` flush) — still reproducible on `pi-web-fetch@0.6.1` as installed in `~/.pi/agent/npm`.

## Hypotheses

1. **Defuddle still called with pathname** — some code path constructs `new URL(pathname)` without base, throwing `ERR_INVALID_URL` with `input: '/voidzero-dev/vite-plus/releases'`. Current `src/extract.ts:runDefuddle(document, baseUrl.href)` is correct, so the pathname must originate upstream: `src/fetch.ts:documentFromResponse` passes `target.url` (a `URL`), but `target.url` could already be a pathname if `validateRemoteUrl` or `requestFollowingRedirects` was fed a pathname (e.g., `Link:` header `</voidzero-dev/vite-plus/releases>` or `location` header).
2. **Guard is too narrow** — `runDefuddle` only captures rejections where `detail` matches `/defuddle/i`. An `ERR_INVALID_URL` from `new URL(pathname)` has message `Invalid URL` and input `'/voidzero-dev/…'` — may not contain `defuddle` in stack, so it escapes to `process` and paints the TUI footer. The screenshot’s stack is truncated at `extractHtmlToMarkdown`, not `defuddle/node`, supporting this.
3. **Upstream `defuddle` detached throw** — `defuddle 0.19.2` (locked, `packages/pi-web-fetch/package.json: "defuddle": "^0.19.2"`) does `new URL(relative, undefined)` on a detached timer after `await Defuddle(..., pageUrl)` resolves, so the guard’s `await Promise.resolve(); await setImmediate` window misses it. `0.19.3` latest (`npm view defuddle version` = `0.19.3`, published `2026-08-22`) is not yet diffed — may fix this.

## Investigation (no code yet)

- [ ] Reproduce deterministically without pi: `node scripts/repro-vite-plus-releases.ts` — fetch `https://github.com/voidzero-dev/vite-plus/releases` via local `src/fetch.ts:fetchCompleteDocument` with real network + mocked `Link:`/`location` fixtures; log `target.url`, `baseUrl.href`, and any `unhandledRejection` that fires within 2s after `extractHtmlToMarkdown`.
- [ ] Capture Defuddle’s exact rejection for `new URL('/path')`: `node -e "new URL('/voidzero-dev/vite-plus/releases')"` vs `new URL('/voidzero-dev/vite-plus/releases', undefined)` — record `message`, `code`, `input`, stack, and whether `/defuddle/i` appears.
- [ ] Confirm installed pi agent version: `cat ~/.pi/agent/npm/node_modules/@zeldrisho/pi-web-fetch/package.json | grep version` + `cat pnpm-lock.yaml | grep defuddle` — verify it’s `0.6.1` + `0.19.2` and that `src/extract.ts` there matches `packages/pi-web-fetch/src/extract.ts:runDefuddle`.
- [ ] Check GitHub releases page HTML locally (`curl -L …/releases | head -n 500`) for duplicate `Latest` anchors inside `<nav>`/`<header>` that should be stripped by `htmlToMarkdownFallback`’s `nav, header, footer` removals but survive Defuddle’s article extraction.

## Fix plan

- [ ] **Harden `src/extract.ts:runDefuddle` guard** — widen `captureUnhandled` to also treat `ERR_INVALID_URL` with `input` starting with `/` as a Defuddle-originated failure when `pageUrl` is known to be absolute, or simply capture _any_ `ERR_INVALID_URL`/`TypeError: Invalid URL` that occurs within the armed window (still scoped by `armed` timer, not global). Ensure the `unhandledRejection` listener is armed _before_ `import("defuddle/node")` and stays armed through both microtask and `setImmediate` flush.
- [ ] **Guarantee absolute `baseUrl` at every call site** — audit `src/fetch.ts:documentFromResponse` (`extractHtml(raw, target.url)`), `src/service.ts:probeUsableRawText`, `src/service.ts:fetchDocumentWithLlmsTxtSupport`, and `src/network-redirects.ts:requestFollowingRedirects.validateUrl(new URL(location, target.url))` — normalize any string `location`/`href` via `new URL(value, target.url).href` and fail closed if the result isn’t `http(s):`. Add an `assertAbsoluteUrl` helper and unit-test it.
- [ ] **Bump `defuddle ^0.19.2 → ^0.19.3`** in `packages/pi-web-fetch/package.json` _in the same fix_ — `npm view defuddle@0.19.3` diff vs `0.19.2`; if the upstream fix is the detached `new URL(relative, undefined)`, the local guard becomes defense-in-depth rather than primary.
- [ ] **Clean GitHub releases noise** — if duplication survives the guard fix, extend `src/extract.ts:removeMalformedSchemaOrgData`/`normalizeSelectorUnsafeIds` or post-process Defuddle markdown to deduplicate adjacent identical `[Latest]` links (or explicitly strip `nav/header` wrappers before `runDefuddle`).

## Verification

- [ ] `vp test packages/pi-web-fetch/tests/extract.test.ts` — add cases: bare pathname `ERR_INVALID_URL` is swallowed and falls back to `basic` without leaking, relative `/path` link in HTML with `baseUrl href` resolves correctly.
- [ ] `vp run validate` full pass (check 114 files, coverage, `test:contracts`, `pack:dry-run`, `test:packages`).
- [ ] Manual: `pi -e ./packages/pi-web-fetch -- web_fetch https://github.com/voidzero-dev/vite-plus/releases` — confirm no footer stack, no duplicated `[Latest]` block, `ctrl+o` expand shows 86 lines cleanly, `details` has `extractor: defuddle` and no `stack` leak.

## Release after green

- Amend `packages/pi-web-fetch/CHANGELOG.md` `## [0.7.0] - 2026-08-24` `### Fixed` entry for this UI break, run `vp run format:changelog`, then re-run `vp run validate` before re-opening PR #72.

## Non-goals

- No new `pi-web-fetch` features beyond the existing `0.7.0` `Added` items (gist `/raw`, `llms.txt` fallback/probe, markdown alternate) — this plan is a bugfix gate.

## References — pi docs

Host pi at `/home/zeldrisho/.vite-plus/packages/@earendil-works/pi-coding-agent/5bbd78b6-72a8-4808-89c1-1dd6745d5056/lib/node_modules/@earendil-works/pi-coding-agent/docs/` (workspace mirror at `node_modules/.pnpm/@earendil-works+pi-coding-agent@0.84.2_…/node_modules/@earendil-works/pi-coding-agent/docs/`; web at https://pi.dev):

- `tui.md` — TUI footer/stack leak, truncated output `ctrl+o to expand` (`86 total, 76 more lines`), truncation limits in `vp`/`pi` (`DEFAULT_MAX_LINES`/`DEFAULT_MAX_BYTES` used in `src/service.ts:truncateHead`).
- `extensions.md` + `packages.md` — extension tool output contract (`<untrusted_web_content>` wrapper), how `web_fetch` markdown is rendered as collapsible vs plain text and why `nav`/`header` noise must be stripped before `Defuddle(document, pageUrl, {markdown:true})`.
- `security.md` — `http(s):` origin checks (`isSafeToProbe` in `src/service.ts`) and why `new URL(pathname)` without base must fail closed.
- `index.md` / `docs.json` — entry points for the docs site; `skills.md` for `pi-web-fetch` skill wiring if the fix touches tool metadata.
