# Vite+ toolchain

This repository uses [Vite+](https://viteplus.dev/guide/) for package installation, formatting, linting, type checking, tests, and task execution. Its unified CLI is `vp`.

## Built-ins and project scripts

- `vp <name>` invokes a Vite+ built-in, such as `vp check` or `vp test`.
- `vp run <name>` invokes a `package.json` script or a configured task, such as `vp run validate`.
- Scripts cannot replace built-in command names.
- Inspect `package.json` and `vite.config.ts` before choosing a command.

## Common commands

| Task                         | Command                              |
| ---------------------------- | ------------------------------------ |
| Install dependencies         | `vp install`                         |
| Show environment diagnostics | `vp env doctor`                      |
| Show toolchain versions      | `vp toolchain`                       |
| Explain a dependency         | `vp why <package>`                   |
| Format, lint, and type-check | `vp check`                           |
| Run one test file            | `vp test <path-to-test>`             |
| Run one package's tests      | `vp run '@zeldrisho/<package>#test'` |
| Run complete validation      | `vp run validate`                    |

Use `vp help` for the command list and `vp <command> --help` for command-specific options. The repository's selected versions are recorded in `package.json`, `pnpm-workspace.yaml`, and `pnpm-lock.yaml`. Installed Vite+ documentation is available under `node_modules/vite-plus/docs`.

## Review checklist

- Run `vp install` after dependency or lockfile changes.
- Run the narrowest relevant test while iterating.
- Run `vp run validate` before requesting review.
- Include `vp env doctor` output when reporting environment or package-manager failures.
