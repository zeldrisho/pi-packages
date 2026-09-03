# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/2.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- escape terminal and bidirectional control characters and bound long or multiline command text in confirmation dialogs without changing the command executed
- ignore empty or oversized rule patterns and load at most 1,000 valid rules
- document and test RPC-host confirmation behavior

## [0.2.0] - 2026-09-02

### Changed

- request termination of the current agent turn when a command is blocked, denied, dismissed, or times out; mixed parallel batches containing allowed calls may continue
- auto-deny interactive prompts after a configurable `promptTimeoutMs` (30 seconds by default)
- create `pi-gate.json` directly on first load with the default timeout and starter prompt/block/allow rules instead of writing an example file

## [0.1.1] - 2026-09-01

### Changed

- identify the matched rule in confirmation prompts, block notifications, and agent-visible error results

## [0.1.0] - 2026-08-25

### Added

- gate bash tool calls against a user-provided JSON configuration
- ship without any default rules and notify the user to configure after install
- write a `pi-gate.json.example` next to the config on first run
- support `prompt`, `block`, and `allow` actions, with longest-pattern-wins resolution
- block rather than auto-approve in non-UI modes

[Unreleased]: https://github.com/zeldrisho/pi-packages/compare/pi-gate-v0.2.0...HEAD
[0.2.0]: https://github.com/zeldrisho/pi-packages/compare/pi-gate-v0.1.1...pi-gate-v0.2.0
[0.1.1]: https://github.com/zeldrisho/pi-packages/compare/pi-gate-v0.1.0...pi-gate-v0.1.1
[0.1.0]: https://github.com/zeldrisho/pi-packages/releases/tag/pi-gate-v0.1.0
