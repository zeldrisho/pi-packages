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

On first load, the extension creates `~/.pi/agent/pi-gate.json` with a default 30-second prompt timeout, starter rules, and a `$schema` reference for editor validation. Existing configuration files are never overwritten.

The published package includes [`config.schema.json`](config.schema.json). New configurations reference its canonical URL automatically; existing configurations can add the same `$schema` property shown below to enable completion and validation in compatible editors.

Edit `~/.pi/agent/pi-gate.json` to customize the rules. `promptTimeoutMs` controls how long a confirmation remains open (30 seconds by default if omitted, with a maximum of one day). Each rule is a substring pattern and one of three actions:

- `prompt` — ask the user to allow or deny the command
- `block` — deny the command without asking
- `allow` — explicitly allow an exception to a broader matching rule

```json
{
  "$schema": "https://raw.githubusercontent.com/zeldrisho/pi-packages/main/packages/pi-gate/config.schema.json",
  "promptTimeoutMs": 30000,
  "operations": {
    "rm -rf": "prompt",
    "sudo": "prompt",
    "sudo apt update": "allow",
    "chmod 777": "block",
    "corepack enable": "block"
  }
}
```

Patterns use simple substring matching. Empty patterns and patterns longer than 1,024 characters are ignored, and at most 1,000 valid rules are loaded. Commands with no matching rule are allowed automatically. The explicit `allow` action is only needed to carve out an exception: in the starter configuration, `sudo apt update` is allowed even though the broader `sudo` rule prompts. When several patterns match, the longest pattern wins.

After editing, run `/reload` to apply the new rules in the current session.

## Behavior

- Only the built-in `bash` tool is gated. Other tools pass through unchanged.
- `prompt` rules ask the user with a two-button confirmation (`Allow` / `Deny`). The dialog identifies the matched rule, wraps its visible occurrences in `»…«`, and auto-denies after `promptTimeoutMs` instead of waiting indefinitely. Commands are normalized and terminal control characters are escaped for display; prompts show at most 2,000 command characters and 20 lines, but an allowed command always executes in full and unchanged.
- `block` rules never ask and always deny. The warning identifies the matched rule.
- `allow` rules are explicit pass-throughs, useful for carving out exceptions.
- Blocked, denied, dismissed, and timed-out calls request early termination. Pi ends the turn only when every finalized result in the tool-call batch requests termination; a mixed parallel batch containing allowed calls may continue.
- RPC hosts use their native selection dialog. In non-interactive modes (`-p`, JSON), `prompt` and `block` rules both block and request termination instead of auto-approving.

### What the agent sees

The confirmation dialog and your choice are not sent directly to the agent.

- If you allow a `prompt` rule, the command runs and the agent receives its normal bash result.
- If you deny or dismiss a `prompt`, the agent receives an error result naming the matched rule and saying the user denied it.
- If a `block` rule matches, the agent receives an error result naming that rule.
- If a `prompt` rule matches without an available UI, the agent receives an error explaining that the matched rule required a prompt.

For example, a blocked `sudo apt update` call reports:

```text
pi-gate: command blocked by rule "sudo": "block"
```

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
