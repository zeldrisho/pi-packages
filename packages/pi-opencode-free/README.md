# @zeldrisho/pi-opencode-free

Experimental access to OpenCode's free-tier models from Pi, preserving Pi's normal system prompt and tools. No account or API key is required.

**Compatibility warning:** [OpenCode documents free-tier chat as requiring OpenCode](https://opencode.ai/v2/docs/console/models). This third-party extension is unsupported by that service. The experimental Bun transport does not guarantee access; full Pi requests still received usage-limit errors during verification. Do not rely on it as a working free provider yet.

## Install

Install [Bun](https://bun.sh) first and make `bun` available on Pi's `PATH`. OpenCode itself need not be installed. To select an existing Bun executable at a different path, set `PI_OPENCODE_FREE_BUN` before starting Pi:

```bash
export PI_OPENCODE_FREE_BUN=/absolute/path/to/bun
```

```bash
pi install npm:@zeldrisho/pi-opencode-free

# Project:
pi install -l npm:@zeldrisho/pi-opencode-free
```

Restart Pi after installing. Use `pi config` to enable or disable the extension, and `pi list` to see installed packages.

## Usage

1. Run `/model`.
2. Type `opencode-free` to filter the list.
3. Select a model tagged `[opencode-free]`.

No `/login` is required. Your prompts are forwarded to OpenCode using its public token through a private local Bun process. The process starts lazily for gateway requests and stops on Pi session shutdown. Catalog metadata and version lookups use Pi's normal HTTP transport. Endpoint and API-key environment overrides are not supported. A caller-provided fetch override takes precedence over the Bun transport.

The model list refreshes automatically when you open `/model`, following Pi's native four-hour catalog refresh policy. Unchanged metadata is revalidated without downloading it again. If discovery is unavailable, the last synced catalog for the current endpoint or Pi's bundled free models remain available.

The provider automatically resolves the current CLI version from OpenCode's official update service, with npm metadata as a fallback, when needed for an online model refresh or inference request. Successful lookups are cached in memory for 24 hours. No OpenCode installation or version configuration is needed. If neither source can provide a valid version and no unexpired cached value exists, inference stops with a retryable connection error rather than using an invented version.

## Usage limits

Free-tier availability, client restrictions, and usage limits are controlled by OpenCode. A `FreeUsageLimitError` does not distinguish an exhausted allowance from a refused third-party request. An existing CLI session working does not guarantee access from Pi or from a new session.

The provider stores one session identity in `<agent-dir>/opencode-free/session.json` and reuses it across Pi runs; it refreshes that identity after 30 days. The agent directory defaults to `~/.pi/agent` and respects `PI_CODING_AGENT_DIR`. Delete the file to force a fresh identity. Retaining an identity does not guarantee upstream access or exempt it from limits.

For troubleshooting with your own session identity, set `PI_OPENCODE_FREE_SESSION_ID` to a canonical `ses_…` value. Valid overrides are persisted. Malformed values, identifiers older than 30 days, or identifiers dated more than two days ahead are ignored. Session identities are not API keys; do not publish or share them.

When OpenCode returns a confirmed free-usage error, the error includes the server-reported reset time in your local date, time, and timezone when available; otherwise it says `Reset time unavailable.` Wait for the reported reset or select another provider with `/model`. A reported reset does not guarantee that access has been restored. Neither Bun nor an identity override resets upstream limits.

## Uninstall

```bash
pi remove npm:@zeldrisho/pi-opencode-free

# Project:
pi remove -l npm:@zeldrisho/pi-opencode-free
```

## License

[MIT](LICENSE)
