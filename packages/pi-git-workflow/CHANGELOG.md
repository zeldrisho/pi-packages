# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/2.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-09-02

### Added

- Detect checked-out branches that are behind or diverged after fetch, then inject actionable hidden context and a deduplicated warning before editing

## [0.2.1] - 2026-09-01

### Fixed

- Fail closed when Git commands are killed or time out, with coverage for disappearing candidate refs and branches whose upstream still exists

## [0.2.0] - 2026-08-27

### Added

- automatically prune and safely delete local branches whose upstream is gone and whose commit is merged into the fetched target
- inject bounded agent context and deduplicated UI notices for branches requiring user review

### Changed

- refresh and pin exact Git refs before cleanup and ordinary branch-deletion checks
- keep remote deletion delegated to GitHub and retain branches when inspection or non-force deletion is uncertain

## [0.1.0] - 2026-08-26

### Added

- enforce `git fetch --prune` and inspect before implementation via `before_agent_start`
- block force branch deletion (`git branch -D` / `--force`) to prevent accidental data loss
- gate regular branch deletion (`git branch -d`) by merge and upstream checks with interactive confirmation
- report dirty working tree status without aborting checkout

[Unreleased]: https://github.com/zeldrisho/pi-packages/compare/pi-git-workflow-v0.3.0...HEAD
[0.3.0]: https://github.com/zeldrisho/pi-packages/compare/pi-git-workflow-v0.2.1...pi-git-workflow-v0.3.0
[0.2.1]: https://github.com/zeldrisho/pi-packages/compare/pi-git-workflow-v0.2.0...pi-git-workflow-v0.2.1
[0.2.0]: https://github.com/zeldrisho/pi-packages/compare/pi-git-workflow-v0.1.0...pi-git-workflow-v0.2.0
[0.1.0]: https://github.com/zeldrisho/pi-packages/releases/tag/pi-git-workflow-v0.1.0
