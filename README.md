# Pi Packages

Monorepo for my personal Pi extensions.

## Packages

| Package                                              | Purpose                                                | Install                                   |
| ---------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------- |
| [`@zeldrisho/pi-gate`](packages/pi-gate)             | Block or confirm bash commands from a user JSON config | `pi install npm:@zeldrisho/pi-gate`       |
| [`@zeldrisho/pi-web-fetch`](packages/pi-web-fetch)   | Fetch public web pages as bounded Markdown             | `pi install npm:@zeldrisho/pi-web-fetch`  |
| [`@zeldrisho/pi-web-search`](packages/pi-web-search) | Search the web with Brave Search                       | `pi install npm:@zeldrisho/pi-web-search` |

Install only the extensions you need using the commands above. See each package README for configuration, behavior, and usage.

## Retired packages

`@zeldrisho/pi-git-workflow` and `@zeldrisho/pi-nested-agent-md` are no longer maintained and have been removed from this repository. Published npm versions remain available but are deprecated; Git history, tags, and GitHub releases are preserved.

- `pi-git-workflow`: use GitHub branch rulesets for server-side protection (they do not protect local Git operations) and ask the agent to clean up branches and worktrees on demand, confirming before anything destructive. Uninstall with `pi remove npm:@zeldrisho/pi-git-workflow` (or `pi remove -l npm:@zeldrisho/pi-git-workflow` for project-local installs).
- `pi-nested-agent-md`: keep essential instructions in one root `AGENTS.md` linking to focused documentation. Uninstall with `pi remove npm:@zeldrisho/pi-nested-agent-md` (or `pi remove -l npm:@zeldrisho/pi-nested-agent-md` for project-local installs).

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
