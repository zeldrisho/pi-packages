# Pi Packages

Monorepo for my personal Pi extensions.

## Packages

| Package                                                        | Purpose                                                | Install                                        |
| -------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------- |
| [`@zeldrisho/pi-gate`](packages/pi-gate)                       | Block or confirm bash commands from a user JSON config | `pi install npm:@zeldrisho/pi-gate`            |
| [`@zeldrisho/pi-git-workflow`](packages/pi-git-workflow)       | Prune refs and safely clean merged local branches      | `pi install npm:@zeldrisho/pi-git-workflow`    |
| [`@zeldrisho/pi-nested-agent-md`](packages/pi-nested-agent-md) | Load scoped nested `AGENTS.md` instructions            | `pi install npm:@zeldrisho/pi-nested-agent-md` |
| [`@zeldrisho/pi-web-fetch`](packages/pi-web-fetch)             | Fetch public web pages as bounded Markdown             | `pi install npm:@zeldrisho/pi-web-fetch`       |
| [`@zeldrisho/pi-web-search`](packages/pi-web-search)           | Search the web with Brave Search                       | `pi install npm:@zeldrisho/pi-web-search`      |

Install only the extensions you need using the commands above. See each package README for configuration, behavior, and usage.

## Project-local installation

Add `-l` to install a package only for the current project:

```bash
pi install -l npm:@zeldrisho/pi-gate
```

Remove the project-local package with the same source:

```bash
pi remove -l npm:@zeldrisho/pi-gate
```

## Development

See the [development guide](docs/development.md) for setup, package conventions, and verification commands. The [architecture guide](docs/architecture.md) describes package boundaries and the web and release data flows.

## License

[MIT](LICENSE)
