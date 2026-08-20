# Web tools enhancement plan (`pi-web-fetch` + `pi-web-search`)

Planning-only document. No implementation is performed in this session. It scopes the work we agreed
on, grounds each decision in the current code and in evidence from the sibling web-tool repos, lists
the invariants that must hold, and proposes process tooling for the shared modules.

## Prior plan status

The previous `plan.md` (repository tech-debt remediation) is **complete**: all 15 items are done,
`vp run validate` passes, line coverage is ~95%, and the six transitive advisories are mitigated via
repo-level `pnpm-workspace.yaml` overrides. That plan is retired into this single document; active
work follows below.

## 1. Decisions (from the planning session)

| #   | Proposal                                                                       | Decision                                                                          | Effect                                              |
| --- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | --------------------------------------------------- |
| 1   | Add multi-provider search routing/fallback (à `pi-web-access` `searchRouting`) | **Skip**                                                                          | Keep Brave-only. No provider fan-out.               |
| 2   | Add a persistent, cross-session cache                                          | **Accept**                                                                        | Disk-backed cache survives sessions.                |
| 3   | PDF / YouTube handlers; GitHub handler                                         | **Skip PDF/YT.** GitHub → rely on Defuddle, with one minimal raw-URL fix (see §4) | No special handlers; assess Defuddle with evidence. |
| 4   | Add an honest-evidence output shape                                            | **Accept**                                                                        | Tool output reports what actually happened.         |
| 5   | Add a keyless second search backend (DuckDuckGo/SearXNG)                       | **Skip**                                                                          | Keep Brave-only.                                    |

Net scope: **enhance, don't expand**. Both packages keep their single-purpose, keyless-fetch /
Brave-search posture. The two accepted items (persistent cache, honest-evidence) are additive metadata
and a storage swap, not new provider or content-type surface area.

## 2. Current state (grounded in the code)

- **Shared, byte-synced modules** (`cache.ts`, `inflight.ts`, `render.ts`) are identical between the
  two packages (verified with `diff`). The repository contract detects drift
  (`tests/repository-contract.test.ts`, lines 30–32 define the three pairs; lines 103–110 fail the
  build on any mismatch). Any change to these three files must be applied identically to both packages.
  `render.ts` is the collapsible-output formatter and is **not** affected by this plan.
- **`pi-web-fetch`** extraction (`src/extract.ts`): already uses `defuddle/node` with markdown output,
  falling back to a linkedom text extractor on any failure. The extractor name is already reported in
  `details.extractor` (`"defuddle" | "basic" | "raw"`).
- **`pi-web-fetch`** output (`src/service.ts` → `WebFetchDetails`): already bounds output, wraps it in
  `<untrusted_web_content>`, and reports `cached`, `truncated`, `contentType`, `title`, `extractor`,
  `offset`/`nextOffset`, `totalCharacters`, `characterCount`, `truncation`. So honest-evidence is
  _partially present today_ — the gap is content-quality signalling, not presence/absence.
- **`pi-web-search`** output (`src/search.ts` → `SearchDetails`): already returns a structured
  `results: SearchResult[]` (url/title/snippet) plus `provider`, `mode`, `resultCount`, `cached`,
  `truncated`, and full-output temp-file details. The rendered text (`format-results.ts`) is a numbered
  `[title](url)` + snippet list wrapped in `<untrusted_web_content>`. Structure exists; the gap is
  per-result quality/status signalling and a request-vs-returned summary.
- **Cache today** (`src/cache.ts` `ExpiringLruCache`): in-memory only, TTL 10 min, 100 entries, 20 MiB
  aggregate markdown/JSON bytes; per-caller cancellation via `InflightCoalescer`
  (`src/inflight.ts`). Search (`search.ts`) and fetch (`service.ts`) each own an instance.

## 3. Scope

**In scope**

- Disk-backed, cross-session cache behind the existing `ExpiringLruCache` API (both packages).
- Honest-evidence metadata for `web_fetch` and `web_search` (additive `details` fields).
- Minimal GitHub URL normalization: rewrite `github.com/.../blob/...` →
  `raw.githubusercontent.com/...` so code is read as clean plain text.

**Out of scope (per decisions)**

- Multi-provider search/fetch routing or fallback chains (decisions 1, 5).
- PDF, YouTube, or any other multimedia extraction (decision 3).
- GitHub clone, tree/contents API, or a dedicated GitHub handler (decision 3). Directory listings stay
  a known limitation (§4).
- Code search and library-docs surfaces (those belong to dedicated tools, not these two packages).
- Cross-session full-text search over the cache (magpi-style `index.db`); we persist for reuse and
  bounds, not for querying.

## 4. Evidence: is Defuddle "strong enough" for GitHub? (decision 3)

We ran `extract.ts`'s exact pipeline (`linkedom` parse + `Defuddle(..., { markdown: true })`) against
live GitHub pages. Findings:

| URL kind                                         | Defuddle result                                                                                                                                                                  | Verdict                                                 |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Repo root (`/owner/repo`)                        | Extracts the README cleanly (~2.3 KB of the package table). No file tree.                                                                                                        | **Adequate** for "what is this repo / read its README". |
| Blob of a `.ts` file (`/blob/main/.../cache.ts`) | Returns ~1.6 KB but **mostly line numbers** from the gutter column; the real code lines are present but fragmented across the two-column `<table>` and interleaved with numbers. | **Weak** — noisy, not clean code.                       |
| Tree/directory (`/tree/main/.../src`)            | Returns nav junk (Notifications / Fork / Star, "## Files", "## src"); the file list lives in React embedded data, not SSR text.                                                  | **Fails** — no usable directory listing.                |
| `raw.githubusercontent.com/...`                  | Plain `text/plain`; the extractor is bypassed and the tool returns the raw text directly.                                                                                        | **Clean** — best path for file contents.                |

**Conclusion:** Defuddle is fine for README/repo-root pages, but it mishandles GitHub's code-rendering
table (line-number pollution) and cannot list directories. The cheapest fix that honours "rely on
Defuddle, no handler" is a **one-line URL normalization**: rewrite
`https://github.com/<o>/<r>/blob/<ref>/<path>` → `https://raw.githubusercontent.com/<o>/<r>/<ref>/<path>`
_before_ fetch. The raw URL is public HTTPS, passes the existing SSRF policy unchanged, and yields
clean text with no extraction needed. Directory/tree pages remain a documented limitation (the agent
can be steered toward `blob`/`raw` URLs, which is the common case for "read this file").

## 5. Design

### A. Persistent cross-session cache (decision 2)

Keep the `ExpiringLruCache<K, V>` contract so `service.ts` (`fetchCache`) and `search.ts`
(`searchCache`) change minimally. Add disk persistence as a layer the cache writes through.

- **Location:** XDG cache dir, e.g. `${XDG_CACHE_HOME:-~/.cache}/pi-web-fetch/` and
  `.../pi-web-search/`. Resolve via Pi config dir if XDG is unset. Files/dirs created `0700`/`0600`
  (consistent with the untrusted-content handling in `security-invariants.md`).
- **Generic, not package-specific:** `cache.ts` gains a small persistence adapter
  (`serialize(v)`, `deserialize(b)`, `keyToPath(k)`). Each package supplies its own serializer
  (`CompleteDocument` for fetch, `SearchResult[]` for search). This keeps `cache.ts` byte-identical
  across both packages.
- **Layering:** memory is the hot layer; on `get`, fall back to disk when the in-memory entry is
  missing and not expired; on `set`, write memory + atomically write disk (temp file + rename).
- **Bounds & TTL:** keep entry-count (100) and aggregate-byte (20 MiB) ceilings; raise TTL from 10 min
  to a cross-session value (proposed 24 h) so entries survive session restarts but still expire.
  Maintain LRU eviction; **eviction deletes the backing file**.
- **Resilience:** corrupt/missing files are treated as a cache miss (never throw into the caller);
  stale entries (TTL past) are deleted on access. Best-effort concurrency: atomic rename for writes;
  last-writer-wins is acceptable for a local dev tool (note as a risk; revisit only if multi-session
  corruption appears).
- **Why not extract a shared package:** the existing architecture decision (prior plan, item 11) keeps
  these three files duplicated to avoid a shared runtime package. This plan preserves that.

### B. Honest-evidence output shape (decision 4)

Additive `details` metadata only — no change to byte/line bounds or untrusted wrapping.

**`web_fetch` (`WebFetchDetails`, in `service.ts`):**

- `requestedUrl` and `finalUrl` (after redirect + GitHub normalization), so the model knows if the URL
  was rewritten.
- `contentKind`: coarse classification — `repository-readme | code-file | directory-listing |
article | raw-text | markup-shell | unknown`. Derived from URL pattern + extraction result.
- `shellSuspected: boolean` — true when extracted text is very short relative to raw bytes, or matches
  known app-shell markers ("enable JavaScript", consent walls). Borrowed from `ketch`'s `spa_markers`
  idea and `pi-web-agent`'s "bot-check pages" caveat.
- `confidence: "high" | "medium" | "low"` — function of extractor (`raw`/`defuddle` > `basic`),
  content length, and `shellSuspected`.
- Keep existing `extractor`, `cached`, `truncated`, `offset`/`nextOffset`.

**`web_search` (`SearchDetails`, in `search.ts`):**

- Per-result `quality` hint on `SearchResult` (e.g. snippet length / presence) so the model can weight
  citations.
- Top-level `evidence` summary: `requestedCount` vs `returnedCount`, `dropped` (results removed by
  bounds), `freshness` applied, `truncated`. Surfaces "Brave gave fewer than asked" honestly.
- Keep existing `provider`, `mode`, `resultCount`, `results`, `cached`, `truncated`, temp-file details.

Both outputs already wrap content in `<untrusted_web_content>` and keep within Pi's 2,000-line / 50 KiB
limit; honest-evidence fields are metadata, not extra raw content, so the security invariants hold.

### C. GitHub raw normalization (decision 3 refinement)

- Add a small URL-normalization step in `pi-web-fetch` **before** the network-policy validation, so the
  _rewritten_ URL is what gets validated and fetched:
  - `https://github.com/<o>/<r>/blob/<ref>/<path>` →
    `https://raw.githubusercontent.com/<o>/<r>/<ref>/<path>`.
  - Leave `/tree/`, repo root, and non-GitHub URLs untouched (Defuddle handles root READMEs; tree pages
    are a documented limitation).
- The rewritten URL is still public HTTPS and passes `network-policy.ts` unchanged; `finalUrl` is
  reported (see §B) so the model sees the canonical source.
- No GitHub API calls, no auth, no clone.

## 6. Reference patterns from example repos

For each accepted item, the sibling repos provide tested, concrete patterns we can borrow.

### A. Persistent cross-session cache

- **magpi `src/cachedb.ts`** — SQLite (`node:sqlite`) _accelerator_ over a file cache; files are the
  source of truth, the index is rebuildable from disk, it degrades to filesystem walks when SQLite is
  absent, evicts LRU by `lastAccess`, uses FTS5 + BM25, sets `WAL` + `busy_timeout=1000`, and makes
  every operation best-effort (try/catch → no-op). **Borrow:** files are source of truth; metadata is a
  rebuildable accelerator; degrade gracefully; best-effort writes.
- **ketch `cache/cache.go`** — `bbolt` store; `os.UserCacheDir()` + `ensurePrivateDir` 0o700; a
  **nil-safe cache** (init failure → no-op cache so the tool still works); `cacheKey = sha256(url)[:8]`
  (avoids filename injection); TTL expiry checked on read; lazy optional `RawHTML` field (`omitempty`).
  **Borrow:** cache init must never break the tool; hash the URL for the on-disk key; private dir 0o700.
- **pi-web-access `storage.ts`** — in-memory `Map` + disk files; `fchmodSync` 0o700/0o600;
  `O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW` (symlink-safe); atomic temp + rename; TTL sweep on access.
  **Borrow:** atomic writes + symlink protection + 0600/0700 perms for any on-disk cache.

### B. Honest-evidence output shape

- **pi-web-agent `src/orchestration/evidence-quality.ts`** — `EvidenceQualityReport` with `counts`
  (official/community/thread/packagePage/primaryContent/distinctHosts), `flags`, and `caveatReasons`
  (`community-only`, `low-diversity`, `unreadable-direct-source`, `possible-conflict`, `bot-check`).
  **Borrow:** the _caveat-reason list_ pattern for our `shellSuspected`/`confidence` and the search
  `evidence` summary; `distinctHosts` as a diversity signal.
- **pi-web-access `source-check.ts`** — `ResearchArtifact` with `sources[]` (rank/url/title/`quality`),
  `passages[]` (`passage_id`, `extraction_span {start,end}`, `content_hash`), `claims[]`
  (`status`: supported/contradicted/unclear/missing-evidence, `confidence`), a top-level `content_hash`
  (sha256), and an `errors[]` array that _surfaces_ failures instead of swallowing them.
  `classifySource()` uses host/path regexes (`official_docs`/`vendor_docs`/`repo_issue`/`blog`/`forum`/
  `news`). **Borrow:** per-source `quality` classification + `content_hash` for stable citation ids +
  _keep errors in the artifact_.
- **ketch `mcp/errors.go`** — stable error prefixes `[validation]`/`[not_found]`/`[upstream]`/
  `[precondition]`/`[cancelled]` mapping to exit codes 2/3/4/5/6, classifying "fix input" vs "retry" vs
  "operator must configure". **Borrow:** when a fetch/search _partially_ fails, tag the failure kind in
  `details` so the model knows whether to retry.

Mapping onto §5 B: `contentKind` ↔ magpi/ketch source-kind thinking; `confidence`/`shellSuspected` ↔
pi-web-agent `caveatReasons`; per-result `quality` + `content_hash` ↔ pi-web-access `classifySource`/
`hashContent`; `evidence` summary + kept errors ↔ pi-web-access artifact + ketch taxonomy.

### C. GitHub raw normalization

- **magpi `src/handlers/github.ts` + `handler.ts`** — `defineHandler` with `match(url)` + `fetch(url,
ctx)`; an SSRF guard in `handler.ts` blocks loopback/link-local/private. **rpiv-web-tools**
  `docs/github-interceptor.md` — an opt-in GitHub URL interceptor returning file trees/dirs via shallow
  clone. We deliberately _don't_ adopt the clone/handler approach (decision 3); the only borrowing is
  the **URL-pattern match** idea (`/blob/<ref>/<path>` → raw) kept as a pre-validation normalize step,
  preserving `pi-web-fetch`'s existing SSRF boundary.

## 7. Sync script for the shared modules

Today, `tests/repository-contract.test.ts` only **detects** drift and fails the build; the agent still
edits one copy and must remember to copy to the other. The proposal below automates the copy.

**`scripts/sync-web-modules.ts`** (new, dependency-free — matches `scripts/format-changelog.ts` style):

- `check` (default): assert the three file pairs are byte-identical; list any diffs; exit 1 on drift.
  CLI-speed companion to the vitest contract, usable in a pre-commit hook.
- `sync --from <pkg>` (default `pi-web-fetch`): copy the source package's copy of each of the three
  files to the other package, making them byte-identical; then run `check`.

It keeps the files **duplicated** (no shared package) per `AGENTS.md`; it only automates the copy. Run
with `vp exec node scripts/sync-web-modules.ts sync --from pi-web-fetch`. Add a root `package.json`
script `sync:web-modules` for discoverability.

```ts
#!/usr/bin/env node
// scripts/sync-web-modules.ts
// Keep packages/pi-web-fetch/src/{cache,inflight,render}.ts byte-for-byte
// identical to packages/pi-web-search/src/{cache,inflight,render}.ts.
//   node scripts/scripts/sync-web-modules.ts            # check (default)
//   node scripts/scripts/sync-web-modules.ts check
//   node scripts/scripts/sync-web-modules.ts sync [--from pi-web-fetch|pi-web-search]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname ?? process.cwd(), "..");
const PACKAGES = ["pi-web-fetch", "pi-web-search"] as const;
const FILES = ["cache.ts", "inflight.ts", "render.ts"] as const;

function paths() {
  return FILES.map((file) => ({
    file,
    a: join(ROOT, "packages", PACKAGES[0], "src", file),
    b: join(ROOT, "packages", PACKAGES[1], "src", file),
  }));
}

function read(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function check(): number {
  let drift = 0;
  for (const { file, a, b } of paths()) {
    const left = read(a);
    const right = read(b);
    if (left === null || right === null) {
      console.error(`missing: ${left === null ? a : b}`);
      drift += 1;
      continue;
    }
    if (left !== right) {
      console.error(`DRIFT: ${file} differs between ${PACKAGES[0]} and ${PACKAGES[1]}`);
      drift += 1;
    } else {
      console.log(`ok: ${file}`);
    }
  }
  return drift;
}

function sync(from: string): number {
  if (!PACKAGES.includes(from as (typeof PACKAGES)[number])) {
    console.error(`--from must be one of: ${PACKAGES.join(", ")}`);
    return 1;
  }
  const source = from === PACKAGES[0] ? PACKAGES[0] : PACKAGES[1];
  const target = source === PACKAGES[0] ? PACKAGES[1] : PACKAGES[0];
  for (const { file } of paths()) {
    const src = join(ROOT, "packages", source, "src", file);
    const dst = join(ROOT, "packages", target, "src", file);
    const content = read(src);
    if (content === null) {
      console.error(`missing source: ${src}`);
      return 1;
    }
    writeFileSync(dst, content, "utf8");
    console.log(`synced ${file}: ${source} -> ${target}`);
  }
  return check() === 0 ? 0 : 1;
}

const [cmd = "check", ...rest] = process.argv.slice(2);
const fromFlag = rest.find((arg) => arg.startsWith("--from="));
const from = fromFlag ? fromFlag.split("=")[1] : PACKAGES[0];

let code = 0;
if (cmd === "check") code = check() === 0 ? 0 : 1;
else if (cmd === "sync") code = sync(from);
else {
  console.error(`unknown command: ${cmd} (expected "check" or "sync")`);
  code = 1;
}
process.exit(code);
```

## 8. Invariant & contract checklist

From `docs/security-invariants.md` and `AGENTS.md`:

- [ ] HTTP(S)-only; embedded-credential URLs rejected; DNS validation rejects local/private/reserved;
      every redirect revalidated; response-size and media-type bounds kept. (GitHub rewrite validates
      the final `raw.githubusercontent.com` URL.)
- [ ] Disk cache files private (`0700`/`0600`), bounded, deleted on eviction; corrupt files ignored.
- [ ] Output stays within explicit byte/line limits; truncation/continuation details reported.
- [ ] Cancellation propagated; per-caller cancellation preserved via `InflightCoalescer`.
- [ ] `cache.ts` / `inflight.ts` / `render.ts` remain **byte-identical** between the two packages
      (repository-contract test must still pass after the `cache.ts` change; `sync-web-modules.ts`
      keeps them in lockstep).
- [ ] Pi-provided packages stay in `peerDependencies` with `"*"`; `files` allowlist unchanged.
- [ ] `vp run validate` passes (check + coverage + contract + pack dry-run + package smoke) before any
      change is proposed.

## 9. Testing plan

- **Cache (persistence):** write entry → simulate restart (new cache instance) → entry still resolvable
  within TTL; entry expired by TTL is absent and its file deleted; LRU eviction past byte/entry ceiling
  deletes backing files; corrupt/partial file → miss, no throw; byte ceiling rejects oversized entries.
- **Honest-evidence:** `web_fetch` details include `contentKind`/`shellSuspected`/`confidence` and the
  values are consistent with the extractor; `web_search` details include `evidence` (requested vs
  returned, dropped) and per-result `quality`; bounds still enforced.
- **GitHub raw:** `blob` URL is rewritten to `raw.githubusercontent.com`, the rewritten URL still passes
  policy, `finalUrl` differs from `requestedUrl`; non-GitHub and `/tree/` URLs are untouched.
- **Sync script:** `check` exits 0 on identical pairs, 1 after an intentional edit; `sync` makes a
  diverged pair identical and `check` passes.
- **Regression:** existing `cache.test.ts`, `caching.test.ts`, `caching-coalescing.test.ts`,
  extraction/redirect/network-policy suites, and `repository-contract.test.ts` stay green.

## 10. Phasing (no implementation this session)

1. **Cache disk layer** — extend `cache.ts` with the persistence adapter; wire `fetchCache` and
   `searchCache` to it; add persistence/eviction/corruption tests. Keep `cache.ts` identical in both
   packages (use `scripts/sync-web-modules.ts sync --from pi-web-fetch`).
2. **Honest-evidence metadata** — extend `WebFetchDetails` and `SearchDetails` (+ `SearchResult`);
   update `service.ts`/`search.ts` classification logic; add tests.
3. **GitHub raw normalization** — add the pre-validation URL rewrite in `pi-web-fetch`; add tests;
   note the directory-listing limitation in the README.
4. **Sync tooling** — add `scripts/sync-web-modules.ts` and a `sync:web-modules` root script.

## 11. Open questions

- Cross-session TTL: 24 h proposed; should it be configurable (global vs project scope, like magpi)?
- Should the disk cache be scoped global-only, or also support a project-local root? (Propose
  global-only for v1 to keep the change small.)
- Directory/tree listings: accept the limitation for now, or add a tiny GitHub contents-API step later?
  (Deferred — not in this plan.)
- Should `sync-web-modules.ts` also verify that `cache.ts` changes compile in both packages, or stay a
  pure byte-sync? (Propose pure byte-sync; compilation is covered by `vp run validate`.)
