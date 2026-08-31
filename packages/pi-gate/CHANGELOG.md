# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/2.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- identify the matched rule in confirmation prompts, block notifications, and agent-visible error results

## [0.1.0] - 2026-08-25

### Added

- gate bash tool calls against a user-provided JSON configuration
- ship without any default rules and notify the user to configure after install
- write a `pi-gate.json.example` next to the config on first run
- support `prompt`, `block`, and `allow` actions, with longest-pattern-wins resolution
- block rather than auto-approve in non-UI modes

[Unreleased]: https://github.com/zeldrisho/pi-packages/compare/pi-gate-v0.1.0...HEAD
[0.1.0]: https://github.com/zeldrisho/pi-packages/releases/tag/pi-gate-v0.1.0
