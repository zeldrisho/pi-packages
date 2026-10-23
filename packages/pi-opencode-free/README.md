# @zeldrisho/pi-opencode-free

Use OpenCode's free-tier models in Pi. OpenCode does not need to be installed, and no account or API key is required.

The extension adds an **OpenCode Free** provider that talks directly to OpenCode's OpenAI-compatible inference endpoint. It uses Pi's normal system prompt and tools; it does not launch OpenCode or import OpenCode's prompt.

## Install

```bash
pi install npm:@zeldrisho/pi-opencode-free

# Project:
pi install -l npm:@zeldrisho/pi-opencode-free
```

Restart Pi after installing. Use `pi config` to enable or disable the extension, and `pi list` to see configured packages and their install paths.

## Usage

1. Run `/model`.
2. Type `opencode-free` to filter the list.
3. Select a model tagged `[opencode-free]`.

The picker may say "Only showing models from configured providers. Use /login to add providers." You do not need to run `/login`; OpenCode Free is already configured.

The model list is synced from OpenCode and matched against Pi's native OpenCode catalog from [pi.dev](https://pi.dev/models), the same catalog Pi uses for model capabilities and compatibility. Models appear and disappear as OpenCode's free catalog changes. After a successful sync, the catalog is cached for later sessions. If Pi starts without network access or the sync fails, it uses the last synced catalog, or the free models in Pi's bundled OpenCode catalog on a first offline run. If the list looks stale, restart Pi to trigger another sync.

## Troubleshooting

If **OpenCode Free** does not appear in `/model`:

- Confirm the package is installed with `pi list`.
- Confirm it is enabled with `pi config`.
- Restart Pi after installing or enabling it.

If the provider appears but no models are listed, check that this machine can reach `https://opencode.ai` and `https://pi.dev`. Discovery needs both; when it cannot run, the extension falls back to the cached catalog or Pi's bundled OpenCode catalog.

## Configuration

| Variable                    | Default                            | Description                                                            |
| --------------------------- | ---------------------------------- | ---------------------------------------------------------------------- |
| `OPENCODE_FREE_API_KEY`     | `public`                           | Bearer token sent to the inference endpoint.                           |
| `OPENCODE_FREE_BASE_URL`    | `https://opencode.ai/inference/v1` | OpenAI-compatible base URL. Point this at a compatible proxy.          |
| `OPENCODE_API_KEY`          | unset                              | Fallback bearer token when `OPENCODE_FREE_API_KEY` is unset.           |
| `OPENCODE_FREE_CLI_VERSION` | compatibility version              | Optional client version reported to the endpoint, for example `2.1.3`. |

For example, to route through a local proxy:

```bash
export OPENCODE_FREE_BASE_URL=http://127.0.0.1:8080/v1
pi
```

The proxy must expose an OpenAI-compatible `/chat/completions` endpoint and should return the current free models from `/models`.

## Notes

- Free-tier availability, rate limits, and model names can change at any time.
- This package is unofficial and is not affiliated with OpenCode.
- Inference and `/models` requests use the configured base URL. Model catalog discovery always contacts `pi.dev` at a fixed URL, so `OPENCODE_FREE_BASE_URL` does not redirect it. Set `OPENCODE_FREE_BASE_URL` only to a proxy you trust, because that proxy receives your prompts and the bearer token.

## Uninstall

```bash
pi remove npm:@zeldrisho/pi-opencode-free

# Project:
pi remove -l npm:@zeldrisho/pi-opencode-free
```

## License

[MIT](LICENSE)
