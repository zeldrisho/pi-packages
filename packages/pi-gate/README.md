# @zeldrisho/pi-gate

Pi extension that blocks or confirms `bash` tool calls and protects its configuration from `write` and `edit` calls.

## Install

```bash
pi install npm:@zeldrisho/pi-gate

# Project:
pi install -l npm:@zeldrisho/pi-gate
```

Use `pi config` to enable or disable this extension interactively. Run `pi list` to see configured packages and their install paths.

## Configure

Edit `~/.pi/agent/gate.json` to choose which commands need approval. The extension creates this file with starter rules when the first session starts. Changes apply before the next gated call, without restarting Pi. Add the optional `$schema` below for editor completion and validation:

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

Rules match command text and have one of three actions:

- `prompt`: ask the user to allow or deny;
- `block`: deny without asking;
- `allow`: explicitly permit matches fully contained within its matching text.

For simple commands, matching is case-insensitive, treats runs of whitespace as a single space, and matches complete words: `git checkout` does not match `git checkout-index`. Restrictive flag and numeric patterns retain prefix coverage, so `rm -rf` still gates `rm -rfv` and `chmod 777` still gates `chmod 7777`.

Literal arguments to `echo` and `printf`, and shell comments, do not trigger unrelated rules: `echo sudo` does not match `sudo`. Explicit output rules such as `echo sudo` still work. An `allow` suppresses only prompt/block matches fully inside its matching text in the same simple command; otherwise any remaining `block` wins over `prompt`. Commands with no match are allowed. Patterns must contain 1–1,024 characters; at most 1,000 valid rules are loaded.

pi-gate is a guard rail, not a sandbox. Complex shell syntax, pipelines, redirects, substitutions, script arguments, or rules containing shell syntax use conservative substring matching and can still prompt on literal text. Generated commands, flag-order variants, and commands run through other tools are not fully understood; keep `allow` patterns specific. Bash path checks remain textual, so a separate earlier `cd ~/.pi/agent` followed by `echo x > gate.json` may not be recognized.

## Usage

The built-in `bash` tool is gated, and `write`/`edit` calls targeting the gate config require approval. Prompt dialogs offer `Allow` and `Deny`; approvals are never remembered. To stop repeated prompts, add a specific `allow` rule to `gate.json`.

Approval dialogs are serialized for concurrent tool calls; cancellation, shutdown, reload, session replacement, or a policy change while a dialog is open denies the pending call. Calls queued before shutdown or session replacement are also denied.

Long commands are truncated in approval dialogs, but an approved command executes in full. Denied, dismissed, blocked, and timed-out calls stop the turn; other allowed calls in a parallel batch may still run. In non-interactive modes (`-p`, JSON), commands requiring approval are denied.

In Herdr-managed panes, install Herdr's Pi integration with `herdr integration install pi` to report pending approvals as `blocked`. Herdr is optional.

## Configuration notes

- `promptTimeoutMs` defaults to 30 seconds and accepts up to one day. Increase it if you need more time to approve calls.
- Set `PI_CODING_AGENT_DIR` if your Pi configuration lives outside `~/.pi/agent`.
- Legacy `pi-gate.json` is used only when `gate.json` is absent. To migrate, rename it to `gate.json`; existing files are never overwritten automatically.
- An unreadable or invalid configuration causes every command to require approval until fixed. If no file exists and one cannot be created, pi-gate warns and allows commands until you create it.

## Uninstall

```bash
pi remove npm:@zeldrisho/pi-gate

# Project:
pi remove -l npm:@zeldrisho/pi-gate
```

## License

[MIT](LICENSE)
