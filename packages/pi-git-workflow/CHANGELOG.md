# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/2.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-08-26

### Added

- enforce `git fetch --prune` and inspect before implementation via `before_agent_start`
- block unsafe `git branch -D` / `--force` deletion until merged and upstream gone
- never discard uncommitted work: abort checkout when dirty and report status

[Unreleased]: https://github.com/zeldrisho/pi-packages/compare/pi-git-workflow-v0.1.0...HEAD
[0.1.0]: https://github.com/zeldrisho/pi-packages/releases/tag/pi-git-workflow-v0.1.0
