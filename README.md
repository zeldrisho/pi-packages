# Pi Packages

Monorepo for my personal Pi extensions, skills, prompts, and themes.

## Packages

| Package                                                            | Type      | Purpose                                                                      | Install                                          |
| ------------------------------------------------------------------ | --------- | ---------------------------------------------------------------------------- | ------------------------------------------------ |
| [`@zeldrisho/pi-gate`](packages/pi-gate)                           | Extension | Block or confirm bash commands from a user JSON config                       | `pi install npm:@zeldrisho/pi-gate`              |
| [`@zeldrisho/pi-web-fetch`](packages/pi-web-fetch)                 | Extension | Fetch public web pages as bounded Markdown                                   | `pi install npm:@zeldrisho/pi-web-fetch`         |
| [`@zeldrisho/pi-web-search`](packages/pi-web-search)               | Extension | Search the web with Brave Search                                             | `pi install npm:@zeldrisho/pi-web-search`        |
| [`@zeldrisho/pi-anthropics-skills`](packages/pi-anthropics-skills) | Skills    | Documentation, testing-strategy, and tech-debt skills adapted from Anthropic | `pi install npm:@zeldrisho/pi-anthropics-skills` |
| [`@zeldrisho/pi-sentry-skills`](packages/pi-sentry-skills)         | Skills    | AGENTS.md, security-review, and PR-writing skills adapted from Sentry        | `pi install npm:@zeldrisho/pi-sentry-skills`     |
| [`@zeldrisho/pi-coderabbit`](packages/pi-coderabbit)               | Prompts   | CodeRabbit review and autofix prompts                                        | `pi install npm:@zeldrisho/pi-coderabbit`        |
| [`@zeldrisho/pi-catppuccin`](packages/pi-catppuccin)               | Theme     | Catppuccin Mocha theme for Pi                                                | `pi install npm:@zeldrisho/pi-catppuccin`        |

Install only the packages or resources you need using the commands above. See each package README for configuration, behavior, and usage.

## Project-local installation

Add `-l` to install a package only for the current project:

```bash
pi install npm:@zeldrisho/pi-gate -l  # extension
pi install npm:@zeldrisho/pi-sentry-skills -l  # skills
pi install npm:@zeldrisho/pi-coderabbit -l  # prompts
pi install npm:@zeldrisho/pi-catppuccin -l  # theme
```

Remove the project-local package with the same source:

```bash
pi remove npm:@zeldrisho/pi-gate -l
```

## Development

See the [development guide](docs/development.md) for contributor setup and verification.

## License

[MIT](LICENSE)
