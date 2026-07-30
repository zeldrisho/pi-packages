# Pi Packages

Monorepo for my personal Pi extensions.

## Packages

| Package                                                        | Purpose                                     | Install                                        |
| -------------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------- |
| [`@zeldrisho/pi-file-remove`](packages/pi-file-remove)         | Prefer `gomi` for personal local removal    | `pi install npm:@zeldrisho/pi-file-remove`     |
| [`@zeldrisho/pi-file-search`](packages/pi-file-search)         | Prefer `fd` for file discovery              | `pi install npm:@zeldrisho/pi-file-search`     |
| [`@zeldrisho/pi-nested-agent-md`](packages/pi-nested-agent-md) | Load scoped nested `AGENTS.md` instructions | `pi install npm:@zeldrisho/pi-nested-agent-md` |
| [`@zeldrisho/pi-vite-plus`](packages/pi-vite-plus)             | Guide agents to use Vite+ workflows         | `pi install npm:@zeldrisho/pi-vite-plus`       |
| [`@zeldrisho/pi-web-fetch`](packages/pi-web-fetch)             | Fetch public web pages as bounded Markdown  | `pi install npm:@zeldrisho/pi-web-fetch`       |
| [`@zeldrisho/pi-web-search`](packages/pi-web-search)           | Search the web with Brave Search            | `pi install npm:@zeldrisho/pi-web-search`      |

Install only the extensions you need using the commands above. See each package README for configuration, behavior, and usage.

## Project-local installation

Add `-l` to install a package only for the current project:

```bash
pi install -l npm:@zeldrisho/pi-file-search
```

Remove the project-local package with the same source:

```bash
pi remove -l npm:@zeldrisho/pi-file-search
```

## Development

See the [development guide](docs/development.md) for setup, package conventions, and verification commands.

## License

[MIT](LICENSE)
