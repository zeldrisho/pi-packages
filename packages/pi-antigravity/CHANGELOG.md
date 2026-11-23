# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/2.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.1] - 2026-11-23

### Fixed

- Parse structured Antigravity error reasons for more accurate quota, rate-limit, capacity, and account-suspension guidance, and accept multiline SSE events.

## [0.2.0] - 2026-11-20

### Changed

- Use the account-advertised Gemini catalog without maintaining a stale static model list.
- Sign-in, token refresh, and requests no longer require the `agy` CLI. The public installed-application OAuth client and the compatibility version are bundled, and a matching client found in an installed CLI is preferred when available.

### Removed

- Claude and GPT-OSS model routes are no longer advertised; only account-advertised Gemini routes are supported.
- First-run model discovery no longer runs `agy models`; the stored catalog and bundled models are used instead.

### Fixed

- Purge legacy non-Gemini entries from persisted catalogs during refresh and restore.
- Preserve the provider's compatibility labels while advertising Gemini-only routes.

## [0.1.0] - 2026-11-18

### Added

- Use the CLI model list as a first-run fallback when account discovery fails.
- Automatically use Pi's configured thinking budgets for discovered single-route token-budget models.
- Refresh Pi's Google and Vertex metadata for matching Gemini thinking choices and limits, with four-hour caching, conditional requests, and an offline fallback.
- Sign in with a Google AI Pro or Ultra account through `/login`, using the installed Antigravity CLI's OAuth client. Project discovery errors report safe status information to help diagnose backend restrictions.
- Use the Gemini, Claude, and GPT-OSS models your plan can reach, with the catalog read from your account and Pi thinking levels mapped to Antigravity runtime models and reasoning budgets.
- Tool calling, image input, streamed reasoning, and subscription usage reporting.
- Automatic token refresh and endpoint failover when a region is at capacity.
- Advertise a bundled Antigravity CLI version for request compatibility.
- Use account-advertised thinking levels and budgets when available, and limit Pi's selectable effort levels to advertised variants.
- Rephrase two phrases in Pi's default system prompt to avoid observed provider-side 429 errors.
- Preserve streamed thinking signatures and omit unsigned thinking from conversation history, allowing Claude follow-up messages to continue.

### Fixed

- Keep long-running streams alive after response headers arrive, avoid replaying generations after transport errors, and continue project discovery after an endpoint failure.
- Preserve distinct tool-call IDs and advertise only supported model routes and image inputs.
- Ignore unrelated loopback callbacks and require the sign-in state when pasting a callback.
- Advertise the installed CLI version when available, falling back to the bundled version.
- Explain when a model has no available server capacity and suggest recovery options.
- Report ambiguous resource exhaustion clearly and avoid repeated automatic retries; retain failover for explicit temporary capacity errors.

[Unreleased]: https://github.com/zeldrisho/pi-packages/compare/pi-antigravity-v0.2.1...HEAD
[0.2.1]: https://github.com/zeldrisho/pi-packages/compare/pi-antigravity-v0.2.0...pi-antigravity-v0.2.1
[0.2.0]: https://github.com/zeldrisho/pi-packages/compare/pi-antigravity-v0.1.0...pi-antigravity-v0.2.0
[0.1.0]: https://github.com/zeldrisho/pi-packages/releases/tag/pi-antigravity-v0.1.0
