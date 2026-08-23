# @zeldrisho/pi-vite-plus

Pi extension that guides coding agents to use [Vite+](https://viteplus.dev/), a unified toolchain built on Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task.

## Install

```bash
pi install npm:@zeldrisho/pi-vite-plus
```

Install only for the current project:

```bash
pi install -l npm:@zeldrisho/pi-vite-plus
```

When Pi's `bash` tool is active, the extension injects complete Vite+ CLI agent guidance. It explains the unified `vp` CLI, distinguishes built-in commands from `package.json` scripts and `vite.config.ts` tasks, points agents to the Vite+ documentation, and provides a review checklist covering installation, checks, tests, project tasks, and environment diagnostics.

The extension provides prompt guidance only. It does not intercept or block tool calls.

## Uninstall

```bash
pi remove npm:@zeldrisho/pi-vite-plus
```

For a project-local installation:

```bash
pi remove -l npm:@zeldrisho/pi-vite-plus
```

## License

[MIT](LICENSE)
