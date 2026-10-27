# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/2.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/zeldrisho/pi-packages/compare/pi-opencode-free-v0.2.1...HEAD
[0.2.1]: https://github.com/zeldrisho/pi-packages/compare/pi-opencode-free-v0.2.0...pi-opencode-free-v0.2.1
[0.2.0]: https://github.com/zeldrisho/pi-packages/compare/pi-opencode-free-v0.1.0...pi-opencode-free-v0.2.0
[0.1.0]: https://github.com/zeldrisho/pi-packages/releases/tag/pi-opencode-free-v0.1.0
