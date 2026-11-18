# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/2.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

- Advertise the installed CLI version when available, falling back to the bundled version.
- Explain when a model has no available server capacity and suggest recovery options.
- Report ambiguous resource exhaustion clearly and avoid repeated automatic retries; retain failover for explicit temporary capacity errors.

[Unreleased]: https://github.com/zeldrisho/pi-packages/compare/pi-antigravity-v0.1.0...HEAD
[0.1.0]: https://github.com/zeldrisho/pi-packages/releases/tag/pi-antigravity-v0.1.0
