# @zeldrisho/pi-opencode-free

Experimental access to OpenCode's free-tier models from Pi. No account, API key, or OpenCode installation is required.

**Compatibility warning:** [OpenCode documents free-tier chat as requiring OpenCode](https://opencode.ai/v2/docs/console/models). This third-party extension is unsupported by that service, and its gateway checks — measured rather than published — can change without notice. See [Free-tier gateway contract](https://github.com/zeldrisho/pi-packages/blob/main/docs/architecture.md#free-tier-gateway-contract) for how they were determined, and [Usage limits](#usage-limits) when a model stops responding.

## Requirements

Install [Bun](https://bun.sh) and make it available on Pi's `PATH`. OpenCode itself need not be installed. To use a Bun executable at another path, set `PI_OPENCODE_FREE_BUN` before starting Pi:

```bash
export PI_OPENCODE_FREE_BUN=/absolute/path/to/bun
```

## Install

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

No `/login` is required, and your prompts are sent to OpenCode's service rather than to a local model. Endpoint and API-key environment overrides are not supported.

The model list refreshes when you open `/model`. If discovery is unavailable, the last synced catalog or Pi's bundled free models remain available.

## Usage limits

Free-tier availability, client restrictions, and usage limits are controlled by OpenCode. The gateway returns `FreeUsageLimitError` both for an exhausted allowance and for a refused request, so the message does not identify which one occurred. Retry later or select another provider with `/model`.

The provider keeps one session identity in `<agent-dir>/opencode-free.json` and reuses it across Pi runs, replacing it after 30 days. The agent directory defaults to `~/.pi/agent` and respects `PI_CODING_AGENT_DIR`. Retaining an identity does not guarantee upstream access or exempt it from limits.

When OpenCode returns a confirmed free-usage error, the error includes the server-reported reset time in your local date, time, and timezone when available; otherwise it says `Reset time unavailable.` Wait for the reported reset or select another provider with `/model`. A reported reset does not guarantee that access has been restored.

## Uninstall

```bash
pi remove npm:@zeldrisho/pi-opencode-free

# Project:
pi remove -l npm:@zeldrisho/pi-opencode-free
```

## License

[MIT](LICENSE)
