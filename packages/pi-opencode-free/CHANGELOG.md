# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/2.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Compact long sessions on free-tier models by summarizing the history in segments with the model you already selected, without switching models or asking for a thinking level. Summaries that stop at the output cap are discarded instead of saved, and one that skips the expected sections is requested again before falling back to Pi's compaction.
- Summarize a long branch in segments when leaving it through `/tree`, keeping Pi's branch-summary format and preamble and carrying the branch's file lists forward.

## [0.3.3] - 2026-11-09

### Fixed

- Avoid treating environment tags split across instruction messages as a valid working-directory declaration.
- Discover eligible free models listed with the Responses API through chat-completions translation.
- Shorten the missing-Bun error while retaining diagnostics for other startup failures.
- Support tool-free compaction requests on gateways that require a tool declaration.
- Preserve existing instructions while placing the working-directory declaration before conflicting or incomplete environment blocks.
- Clarify that a free-usage error may indicate a refused request rather than exhausted quota.

## [0.3.2] - 2026-10-30

### Changed

- Remove the package's Node.js engine restriction; Node.js 24 remains the tested runtime.

### Fixed

- Replace Pi's working-directory block with the block free-tier requests require instead of sending both.
- Preserve requests without tools instead of adding a synthetic read tool.

## [0.3.1] - 2026-10-28

### Changed

- Keep Pi’s declared tools unchanged and minimize the compatibility prompt and tool added for free-tier requests.

## [0.3.0] - 2026-10-28

### Added

- Add an experimental Bun transport for free-tier requests, requiring Bun on `PATH` or `PI_OPENCODE_FREE_BUN`.

### Changed

- Enable free-tier models in Pi using Pi's own system prompt and tools, without an OpenCode installation.
- Reuse one session identity across Pi runs.

### Fixed

- Date session identifiers from the system clock so their 30-day retention window matches the OpenCode CLI.

## [0.2.1] - 2026-10-25

### Changed

- Show usage-limit reset times in 24-hour format without seconds while retaining your local date and timezone.

### Fixed

- Avoid repeated catalog requests when reopening the model picker by following Pi's native four-hour refresh policy and revalidating unchanged metadata.
- Stop Pi from automatically retrying exhausted free-tier usage limits while preserving server-reported reset times.

## [0.2.0] - 2026-10-24

### Added

- Show shorter usage-limit errors with server-reported reset times in your local date, time, and timezone.

### Fixed

- Resolve the current OpenCode CLI version automatically at runtime from the official update service, with npm metadata as a fallback, instead of advertising a synthetic compatibility version.
- Keep valid free models available when individual catalog entries are malformed.
- Fix request-format errors during automatic compaction, branch summaries, and nested model calls.

## [0.1.0] - 2026-10-23

### Added

- Add the OpenCode Free provider for using OpenCode's free-tier models in Pi without an OpenCode installation or API key.

### Changed

- Discover free models through Pi's native OpenCode catalog from pi.dev instead of models.dev, preserving Pi's capabilities and compatibility metadata.

[Unreleased]: https://github.com/zeldrisho/pi-packages/compare/pi-opencode-free-v0.3.3...HEAD
[0.3.3]: https://github.com/zeldrisho/pi-packages/compare/pi-opencode-free-v0.3.2...pi-opencode-free-v0.3.3
[0.3.2]: https://github.com/zeldrisho/pi-packages/compare/pi-opencode-free-v0.3.1...pi-opencode-free-v0.3.2
[0.3.1]: https://github.com/zeldrisho/pi-packages/compare/pi-opencode-free-v0.3.0...pi-opencode-free-v0.3.1
[0.3.0]: https://github.com/zeldrisho/pi-packages/compare/pi-opencode-free-v0.2.1...pi-opencode-free-v0.3.0
[0.2.1]: https://github.com/zeldrisho/pi-packages/compare/pi-opencode-free-v0.2.0...pi-opencode-free-v0.2.1
[0.2.0]: https://github.com/zeldrisho/pi-packages/compare/pi-opencode-free-v0.1.0...pi-opencode-free-v0.2.0
[0.1.0]: https://github.com/zeldrisho/pi-packages/releases/tag/pi-opencode-free-v0.1.0
