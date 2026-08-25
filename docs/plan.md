# Plan — fix `pi-web-fetch` `vite-plus/releases` rendering

**Status:** active — remaining only. Important completed work split to `docs/fix-vite-plus-releases.md`. Original full plan captured there.

## Remaining

- [ ] Manual: `pi -e ./packages/pi-web-fetch -- web_fetch https://github.com/voidzero-dev/vite-plus/releases` — confirm no footer stack, no duplicated `[Latest]`/`[vite-plus v0.3.0]`, `ctrl+o` expands 86 lines, `details.extractor: defuddle`
- [ ] Release: manually write `packages/pi-web-fetch/CHANGELOG.md` release entry from `## [Unreleased]` (currently holds the fix, since `0.7.0` is published `ab04905`) after manual green — `vp run format:changelog` then `vp run validate` then publish

## Notes

- Fix branch `fix/pi-web-fetch-releases-guard` holds `c45efc3` + `c597167` (guard hardening, absolute URLs, chrome strip, dedup, `defuddle ^0.19.3`, `vp exec node` → `node`, Node shim `24.19.0`).
- Non-goal unchanged: no new `pi-web-fetch` features beyond `0.7.0` `Added` items.
