# Architecture

This repository publishes independent Pi extensions from `packages/*`. Each package is loaded directly
from TypeScript, owns its runtime dependencies, and can be installed without the rest of the workspace.
For setup and package behavior, use the package READMEs. For trust-boundary requirements, see
[security invariants](security-invariants.md); for publishing mechanics, see the
[release guide](release.md).

## Package boundaries

Package manifests remain independently publishable and expose one Pi entry point, `src/index.ts`.
Pi-provided APIs are peer dependencies because the host supplies them. The root workspace provides a
locked development resolution and smoke-tests the packed extensions against that resolution.

`pi-web-fetch` and `pi-web-search` intentionally contain byte-identical copies of `cache.ts`,
`inflight.ts`, and `render.ts`. This keeps both npm packages independent and avoids creating a shared
runtime package for three small utilities. `tests/repository-contract.test.ts` detects drift. Extract
a shared package only if another consumer appears or synchronized maintenance becomes materially
burdensome. Do not extract only part of web-fetch's validate–resolve–pin–redirect security boundary.

## Web fetch

```mermaid
flowchart LR
  A[Tool arguments] --> B[Schema and runtime bounds]
  B --> C[Cache / in-flight coalescing]
  C --> D[Validate URL]
  D --> E[Resolve every DNS answer]
  E --> F[Reject non-global addresses]
  F --> G[Request pinned address]
  G --> H{Redirect?}
  H -- yes --> D
  H -- no --> I[Bound response bytes and media type]
  I --> J[Extract HTML or decode text]
  J --> K[Cache complete document]
  K --> L[Optional deterministic selection]
  L --> M[Slice continuation]
  M --> N[Wrap and bound untrusted output]
```

The validated address is passed to the transport, while the original hostname remains available for
TLS and HTTP host validation. Every redirect restarts validation and receives a new pinned target.
Timeout and caller cancellation cover resolution, transport, and extraction. The cache stores the
complete extracted document; optional query-focused selection derives a separate view without
mutating that canonical entry. Continuation offsets remain stable within the selected view, and each
caller still has independent cancellation through the in-flight coalescer.

Cache freshness and retention are separate. Fresh representations are hits; stale representations
remain available only for a bounded revalidation window and send `ETag` or `Last-Modified`
validators through the same validated and pinned transport. A `304` refreshes the canonical entry,
while a changed or validator-less representation is a miss. Result evidence distinguishes hits,
revalidations, and misses rather than collapsing all cache use into one boolean.

Origin coordination bounds concurrent request starts. Retryable `429` and `503` responses honor a
capped `Retry-After` value or use capped jittered backoff, with a fixed attempt limit. Queuing and
backoff remain abortable per caller, and retry response bodies are discarded rather than consumed
without a bound.

HTML evidence reports separate JavaScript-required, bot-wall, consent-interstitial, and
sparse-extraction diagnostics. It may also expose a bounded, normalized set of internal and external
HTTP(S) links with bounded anchor text and omitted counts. Unsafe schemes and credential-bearing
links are rejected, and links remain metadata: acquisition never traverses them implicitly.

The blocked-address table is maintained in `packages/pi-web-fetch/src/network-policy.ts` against the
[IANA IPv4](https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry.xhtml)
and [IANA IPv6](https://www.iana.org/assignments/iana-ipv6-special-registry/iana-ipv6-special-registry.xhtml)
special-purpose registries; its table comment records the latest review date (2026-08-03). Boundary
tests exercise every range endpoint. Review the registries at least quarterly and record the review
date beside the table even when no range changes. Registry changes require a security
review that preserves DNS-answer validation, address pinning, and redirect revalidation; update the
explicit endpoint fixtures from the registry data rather than accepting generated ranges without
review.

## Web search

```mermaid
flowchart LR
  A[Mode-aware schema] --> B[Runtime limits]
  B --> C[Cache / in-flight coalescing]
  C --> D[Brave web or context request]
  D --> E[Bound response and normalize fields]
  E --> F[Format untrusted output]
  F --> G{Within Pi limits?}
  G -- yes --> H[Return]
  G -- no --> I[Private temporary file]
  I --> J[Return bounded preview and path]
  J --> K[Delete on session shutdown]
```

The API key is read at request time only and is excluded from cache keys, output, and errors. Web mode
returns normalized provider links and snippets. Context mode uses only Brave's context endpoint; it
does not fetch result URLs. Identical requests coalesce, but cancellation remains per caller. Large
formatted results are written under a package-owned temporary directory and removed after write
failure or session shutdown.

## Data acquisition and derived views

Keep acquisition, canonical storage, selection, and presentation as separate stages. Cache complete
bounded source representations rather than query-specific projections; derive focused, ranked, or
otherwise reduced views locally so another request can recover omitted context without another
network fetch. Derived views must preserve source order when practical and report what was selected
or omitted. Relevance and extraction-quality signals describe processing behavior, not source truth
or calibrated answer confidence. Evaluate ranking changes against deterministic heading, phrase,
and stemming cases before modifying selection; preserve source order and continuation semantics,
and retain known misses in the baseline until an intentional ranking change addresses them.

Network optimizations—including revalidation, retries, metadata probes, and redirect handling—must
reuse the package's complete transport security boundary. Do not introduce an auxiliary HTTP client
that bypasses address validation, pinning, response limits, cancellation, or redirect revalidation.
Expensive rendering or autonomous multi-page traversal should not become an implicit fallback in a
small fetch or search operation.

## Release automation

```mermaid
flowchart LR
  A[Agent bumps package.json] --> B[Agent writes CHANGELOG entry]
  B --> C[Agent pushes component tag]
  C --> D[Workflow resolves package from tag]
  D --> E[Workflow reads CHANGELOG section as notes]
  E --> F[Create GitHub release]
  F --> G[Publish npm version with OIDC]
```

`scripts/release.ts` resolves a `<package>-v<version>` tag to its package and
verifies the tag version matches the manifest version. It then reads the
package's `CHANGELOG.md` section for the released version and writes it to a
notes file consumed by `gh release create`, which creates the GitHub release via the GitHub CLI. The
workflow publishes the package through npm trusted publishing (OIDC). The agent
owns the version and changelog; the workflow only reads them. Details, approvals,
and escalation conditions remain in [release.md](release.md).

Note: `repository-contract.test.ts` is a vitest suite run via `vp run test:contracts` (and
covered by `vp test`). `package-smoke-test.ts` remains an executable smoke-test script run from
`tests/` via `vp run test:packages`; it is not a vitest suite.
