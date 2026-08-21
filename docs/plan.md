# Web tools enhancement plan (`pi-web-fetch` + `pi-web-search`)

**Retired — complete.** This plan scoped the disk-backed cross-session cache, honest-evidence
metadata, and GitHub `blob` → `raw` URL normalization. All phases shipped:

- Persistent disk cache (24 h TTL, private `0700`/`0600`, atomic writes) — `pi-web-fetch@0.6.0`,
  `pi-web-search@0.5.0`.
- Honest-evidence metadata (`contentKind`, `shellSuspected`, `confidence` for fetch; `evidence`
  summary and per-result `quality` for search) — same releases.
- GitHub raw normalization (`/blob/<ref>/<path>` → `raw.githubusercontent.com`) — same release.
- Shared-module sync tooling (`scripts/sync-web-modules.ts`, root script `sync:web-modules`) with
  drift detection in `tests/repository-contract.test.ts`.

Open questions from the original plan were resolved by the implementation: fixed (non-configurable)
24 h TTL, global-only cache scope, pure byte-sync in the sync tooling.

The only consciously deferred item remains the GitHub `/tree/` directory-listing limitation, which
is documented in `packages/pi-web-fetch/README.md`; revisit only if it becomes a recurring friction
point.
