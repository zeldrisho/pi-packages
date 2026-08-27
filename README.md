# Pi Packages

Monorepo for my personal Pi extensions.

## Packages

| Package                                                        | Purpose                                                  | Install                                        |
| -------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------- |
| [`@zeldrisho/pi-cloudflare`](packages/pi-cloudflare)           | Guide agents to retrieve current Cloudflare Workers docs | `pi install npm:@zeldrisho/pi-cloudflare`      |
| [`@zeldrisho/pi-file-remove`](packages/pi-file-remove)         | Prefer `gomi` for personal local removal                 | `pi install npm:@zeldrisho/pi-file-remove`     |
| [`@zeldrisho/pi-file-search`](packages/pi-file-search)         | Prefer `fd` for file discovery                           | `pi install npm:@zeldrisho/pi-file-search`     |
| [`@zeldrisho/pi-gate`](packages/pi-gate)                       | Block or confirm bash commands from a user JSON config   | `pi install npm:@zeldrisho/pi-gate`            |
| [`@zeldrisho/pi-git-workflow`](packages/pi-git-workflow)       | Prune refs and safely clean merged local branches        | `pi install npm:@zeldrisho/pi-git-workflow`    |
| [`@zeldrisho/pi-nested-agent-md`](packages/pi-nested-agent-md) | Load scoped nested `AGENTS.md` instructions              | `pi install npm:@zeldrisho/pi-nested-agent-md` |
| [`@zeldrisho/pi-vite-plus`](packages/pi-vite-plus)             | Guide agents to use Vite+ workflows                      | `pi install npm:@zeldrisho/pi-vite-plus`       |
| [`@zeldrisho/pi-web-fetch`](packages/pi-web-fetch)             | Fetch public web pages as bounded Markdown               | `pi install npm:@zeldrisho/pi-web-fetch`       |
| [`@zeldrisho/pi-web-search`](packages/pi-web-search)           | Search the web with Brave Search                         | `pi install npm:@zeldrisho/pi-web-search`      |

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

See the [development guide](docs/development.md) for setup, package conventions, and verification commands. The [architecture guide](docs/architecture.md) describes package boundaries and the web and release data flows.

## License

[MIT](LICENSE)
