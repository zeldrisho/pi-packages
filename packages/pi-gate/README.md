# @zeldrisho/pi-gate

Pi extension that blocks or confirms `bash` tool calls using a user-provided JSON configuration.

## Install

```bash
pi install npm:@zeldrisho/pi-gate
# project-local:
pi install -l npm:@zeldrisho/pi-gate
```

## Configure

On first load, the extension creates `~/.pi/agent/pi-gate.json` with starter rules and a 30-second prompt timeout. Existing files are never overwritten. The published package includes [`config.schema.json`](config.schema.json); use this schema URL for editor completion:

```json
{
  "$schema": "https://raw.githubusercontent.com/zeldrisho/pi-packages/main/packages/pi-gate/config.schema.json",
  "promptTimeoutMs": 30000,
  "operations": {
    "rm -rf": "prompt",
    "sudo": "prompt",
    "sudo apt update": "allow",
    "chmod 777": "block"
  }
}
```

Rules use substring matching and have one of three actions:

- `prompt`: ask the user to allow or deny;
- `block`: deny without asking;
- `allow`: explicitly permit an exception to a broader match.

Empty or over-1,024-character patterns are ignored, at most 1,000 valid rules are loaded, and commands with no match are allowed. The longest matching pattern wins. `promptTimeoutMs` defaults to 30 seconds and is capped at one day. Run `/reload` after editing.

## Behavior

Only the built-in `bash` tool is gated. Prompt dialogs offer `Allow` and `Deny`, escape terminal controls, and show at most 2,000 command characters and 20 lines; an allowed command executes in full and unchanged. Blocked, denied, dismissed, and timed-out calls request early termination. A parallel batch continues when it contains allowed calls. In non-interactive modes (`-p`, JSON), prompts and blocks deny and request termination.

The agent receives normal bash output after approval, or a bounded error naming the matched rule after denial or blocking. Dialogs and choices are not sent directly to the agent. RPC hosts use their native selection dialog.

## Uninstall

```bash
pi remove npm:@zeldrisho/pi-gate
pi remove -l npm:@zeldrisho/pi-gate  # project-local
```

## License

[MIT](LICENSE)
