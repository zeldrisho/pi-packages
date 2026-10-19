# Anubis WebAssembly fixtures

## `anubis-sha256.wasm`

The baseline `sha256` proof-of-work module written and published by the
[Anubis](https://github.com/TecharoHQ/anubis) project. It is committed here so
the `sha256`, `hashx`, and `argon2id` code paths can be tested offline without
depending on a live challenge server.

- Upstream project: <https://github.com/TecharoHQ/anubis>
- Upstream version: `v1.28.1`
- Original path: `web/static/wasm/baseline/sha256.wasm`
- Sources: `wasm/pow/sha256/src/lib.rs` and `wasm/anubis/src/lib.rs`
- License: MIT, Copyright (c) 2025 Xe Iaso <me@xeiaso.net>
- SHA-256: `abaf04b5e468a33a21855913cb92ecb382fb0c1e4d790ce317cc922068b0ce65`

The module was extracted from the published `anubis-1.28.1-linux-amd64`
release binary, which embeds the compiled module. It imports only
`anubis.anubis_update_nonce` and exports `memory`, `data_ptr`,
`set_data_length`, `anubis_work`, `result_hash_ptr`, `result_hash_size`, and the
`verification_hash_*` helpers.

The benchmark fixture is used exclusively by the package test suite. It is not
included in the published package.
