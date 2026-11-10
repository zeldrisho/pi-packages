# @zeldrisho/pi-opencode-free

Use OpenCode's free-tier models from Pi. This experimental extension is independently maintained, and access may change without notice. OpenCode states that its free-tier chat models require OpenCode; access from Pi is not guaranteed. No account, API key, or OpenCode installation is required by this extension.

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

## Long sessions

Free-tier models can accumulate more history than one compaction summary fits into. When a single summary request would leave too little output room, the extension summarizes the history in segments with the model you are already using and merges them into one checkpoint. Segment sizes and answer room come from the selected model's window and output limit, so the behavior adapts to every free model rather than to one of them. It never switches models and never asks for a thinking level, so your `/model` choice and thinking level stay unchanged. A summary that stops at the output cap is never saved: the extension asks once more when a checkpoint skips the expected sections and otherwise leaves the session to Pi's native compaction. Small histories and other providers keep that native behavior.

The same applies when you leave a branch in `/tree` and choose **Summarize**: a long branch is summarized in segments, and the result keeps Pi's branch-summary format and its "you explored a different branch" preamble. Choosing **No summary** or **Summarize with custom prompt** behaves as before, and custom instructions are honored either as extra focus or, with **Replace instructions**, as the whole prompt.

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
