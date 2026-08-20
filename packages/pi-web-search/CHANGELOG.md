# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/2.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Persist search results to a private cross-session disk cache (24h TTL) behind the existing in-memory cache
- Report honest-evidence metadata (`evidence` summary and per-result `quality`) in `details`

## [0.4.2] - 2026-08-05

### Changed

- Document runtime enforcement of the context query limit ([347b386](https://github.com/zeldrisho/pi-packages/commit/347b386c62f33d489b6be207aff2a96f491eced0))

### Fixed

- Emit provider-compatible object schema for tool parameters ([fe81916](https://github.com/zeldrisho/pi-packages/commit/fe819161e9cf61be09a0d68be713b63cb318155e))

## [0.4.1] - 2026-08-03

### Changed

- Clarify local package management ([f5b420e](https://github.com/zeldrisho/pi-packages/commit/f5b420eba246eb6a372a4b6a9036a060b9db623b))
- Strengthen repository maintenance boundaries ([a44da67](https://github.com/zeldrisho/pi-packages/commit/a44da679b93ae6ea7ebdd77389bf84716b195e33))
- Strengthen maintenance safety ([8a26436](https://github.com/zeldrisho/pi-packages/commit/8a26436780373f21535580224b59bc6dd2a4ad72))

### Fixed

- Address pull request review feedback ([3b05033](https://github.com/zeldrisho/pi-packages/commit/3b05033003d173809134d9e2d2a53e82e45050b6))

## [0.4.0] - 2026-07-25

### Added

- **web-tools:** strengthen independent tool boundaries ([71aba47](https://github.com/zeldrisho/pi-packages/commit/71aba47db47483b6a75935796a1747603850aa96))

## [0.3.1] - 2026-07-22

### Fixed

- address consolidated review feedback ([cea33a1](https://github.com/zeldrisho/pi-packages/commit/cea33a1f30783bd19231fe9dc69686c58f313785))

## [0.3.0] - 2026-07-20

### Added

- **web:** Add collapsible web tool results ([e8664d6](https://github.com/zeldrisho/pi-packages/commit/e8664d6c07b719d92f18d9a0048b47cc1970b97c))

## [0.2.0] - 2026-07-19

### Added

- Add bounded Brave web search ([cbc9491](https://github.com/zeldrisho/pi-packages/commit/cbc9491dce36555ab91b6bef203ec8b380596a89))

[Unreleased]: https://github.com/zeldrisho/pi-packages/compare/pi-web-search-v0.4.2...HEAD
[0.4.2]: https://github.com/zeldrisho/pi-packages/compare/pi-web-search-v0.4.1...pi-web-search-v0.4.2
[0.4.1]: https://github.com/zeldrisho/pi-packages/compare/pi-web-search-v0.4.0...pi-web-search-v0.4.1
[0.4.0]: https://github.com/zeldrisho/pi-packages/compare/pi-web-search-v0.3.1...pi-web-search-v0.4.0
[0.3.1]: https://github.com/zeldrisho/pi-packages/compare/pi-web-search-v0.3.0...pi-web-search-v0.3.1
[0.3.0]: https://github.com/zeldrisho/pi-packages/compare/pi-web-search-v0.2.0...pi-web-search-v0.3.0
[0.2.0]: https://github.com/zeldrisho/pi-packages/releases/tag/pi-web-search-v0.2.0
