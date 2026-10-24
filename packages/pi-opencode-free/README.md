# @zeldrisho/pi-opencode-free

Use OpenCode's free-tier models in Pi with Pi's normal system prompt and tools. OpenCode does not need to be installed, and no account or API key is required.

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

No configuration or `/login` is required. Your prompts are sent directly to OpenCode using its public token. Endpoint and API-key environment overrides are not supported.

The model list refreshes automatically when you open `/model`, following Pi's native four-hour catalog refresh policy. Unchanged metadata is revalidated without downloading it again. If discovery is unavailable, the last synced catalog for the current endpoint or Pi's bundled free models remain available.

The provider automatically resolves the current CLI version from OpenCode's official update service, with npm metadata as a fallback, when needed for an online model refresh or inference request. Successful lookups are cached in memory for 24 hours. No OpenCode installation or version configuration is needed. If neither source can provide a valid version and no unexpired cached value exists, inference stops with a retryable connection error rather than using an invented version.

## Usage limits

Free-tier availability and limits are controlled by OpenCode. When a usage limit is reached, the error includes the server-reported reset time in your local date, time, and timezone when available; otherwise it says `Reset time unavailable.`

Wait for the reported reset or select another provider with `/model`. A reported reset does not guarantee that access has been restored. The extension cannot reset or bypass upstream limits.

## Uninstall

```bash
pi remove npm:@zeldrisho/pi-opencode-free

# Project:
pi remove -l npm:@zeldrisho/pi-opencode-free
```

## License

[MIT](LICENSE)
