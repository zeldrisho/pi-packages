# @zeldrisho/pi-opencode-free

Use OpenCode's free-tier models from Pi. This experimental extension is independently maintained, and access may change without notice. No account, API key, or OpenCode installation is required.

## Requirements

Install the [Bun runtime](https://bun.sh); the extension uses it to send model requests. Bun must be available as `bun` on `PATH`. Optionally, set `PI_OPENCODE_FREE_BUN` to the Bun executable's path if you need to use a different installation.

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

Your prompts are sent to OpenCode's service. Endpoint and API-key environment overrides are not supported.

The model list refreshes when you open `/model`. If discovery is unavailable, the last synced catalog or Pi's bundled free models remain available.

## Usage limits

OpenCode controls availability and usage limits. `FreeUsageLimitError` can mean either an exhausted allowance or a refused request. When available, the error shows the server-reported reset time in your local timezone; otherwise it says `Reset time unavailable.` Retry later or select another provider with `/model`. A reported reset does not guarantee restored access.

## Uninstall

```bash
pi remove npm:@zeldrisho/pi-opencode-free

# Project:
pi remove -l npm:@zeldrisho/pi-opencode-free
```

## License

[MIT](LICENSE)
