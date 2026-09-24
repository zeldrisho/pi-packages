# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/2.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Support reviewing an open pull request by number when its head commit is checked out locally.

## [0.2.0] - 2026-09-23

### Changed

- Extend the autofix prompt to inspect outside-diff and overflow findings in CodeRabbit review summaries.
- Clarify prompt behavior, safety requirements, and mixed-source license documentation.
- Align autofix modes and revision-scoped findings; strengthen review scope, argument, and sensitive-file safeguards.

## [0.1.0] - 2026-09-17

### Added

- CodeRabbit review and individually approved autofix prompt templates

[Unreleased]: https://github.com/zeldrisho/pi-packages/compare/pi-coderabbit-v0.2.0...HEAD
[0.2.0]: https://github.com/zeldrisho/pi-packages/compare/pi-coderabbit-v0.1.0...pi-coderabbit-v0.2.0
[0.1.0]: https://github.com/zeldrisho/pi-packages/releases/tag/pi-coderabbit-v0.1.0
