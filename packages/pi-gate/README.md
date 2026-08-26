# @zeldrisho/pi-gate

Pi extension that blocks or confirms bash tool calls based on a user-provided JSON configuration.

## Install

```bash
pi install npm:@zeldrisho/pi-gate
```

Install only for the current project:

```bash
pi install -l npm:@zeldrisho/pi-gate
```

## Configure

The extension ships with **no default rules**. On first load, an example configuration is written to `~/.pi/agent/pi-gate.json.example` and a warning notifies you that no configuration is active. Every bash command is allowed until you create a configuration.

Copy the example and edit it:

```bash
cp ~/.pi/agent/pi-gate.json.example ~/.pi/agent/pi-gate.json
```

Then edit `~/.pi/agent/pi-gate.json` to add your rules. Each rule is a substring pattern and one of three actions:

- `prompt` — ask the user to allow or deny the command
- `block` — deny the command without asking
- `allow` — explicitly allow (use to carve out an exception to a broader rule)

```json
{
  "operations": {
    "rm -rf": "prompt",
    "sudo": "prompt",
    "chmod 777": "block",
    "corepack enable": "block"
  }
}
```

Patterns use simple substring matching. When several patterns match the same command, the longest pattern wins, so a narrow `allow` rule can override a broader `block` or `prompt` rule.

After editing, run `/reload` to apply the new rules in the current session.

## Behavior

- Only the built-in `bash` tool is gated. Other tools pass through unchanged.
- `prompt` rules ask the user with a two-button confirmation (`Allow` / `Deny`).
- `block` rules never ask and always deny.
- `allow` rules are explicit pass-throughs, useful for carving out exceptions.
- In non-interactive modes (`-p`, JSON), `prompt` and `block` rules both block the command instead of auto-approving.

## Uninstall

```bash
pi remove npm:@zeldrisho/pi-gate
```

For a project-local installation:

```bash
pi remove -l npm:@zeldrisho/pi-gate
```

## License

[MIT](LICENSE)
