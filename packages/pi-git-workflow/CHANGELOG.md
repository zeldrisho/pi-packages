# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/2.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-08-26

### Added

- enforce `git fetch --prune` and inspect before implementation via `before_agent_start`
- block force branch deletion (`git branch -D` / `--force`) to prevent accidental data loss
- gate regular branch deletion (`git branch -d`) by merge and upstream checks with interactive confirmation
- report dirty working tree status without aborting checkout

[Unreleased]: https://github.com/zeldrisho/pi-packages/compare/pi-git-workflow-v0.1.0...HEAD
[0.1.0]: https://github.com/zeldrisho/pi-packages/releases/tag/pi-git-workflow-v0.1.0
