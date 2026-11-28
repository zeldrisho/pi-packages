# pi-init

Pi prompt template that adds `/init` to generate an `AGENTS.md` contributor guide.

## Install

```bash
pi install npm:@zeldrisho/pi-init

# Project:
pi install -l npm:@zeldrisho/pi-init
```

## Usage

Run `/init` from your repository root. The prompt asks the model to leave an existing `AGENTS.md` untouched. If Pi is already running, use `/reload` after installing.

## Attribution

The [OpenAI Codex `/init` prompt](https://github.com/openai/codex/blob/516f2780fd227a80cd9fe89488f5039245090b71/codex-rs/tui/assets/prompt_for_init_command.md) (Copyright 2025 OpenAI) is unchanged except for added Pi metadata.

## Uninstall

```bash
pi remove npm:@zeldrisho/pi-init

# Project:
pi remove -l npm:@zeldrisho/pi-init
```

## License

[Apache-2.0](LICENSE).
