# @zeldrisho/pi-vite-plus

Pi extension that guides coding agents to use the [Vite+](https://viteplus.dev/) unified toolchain.

## Install

```bash
pi install npm:@zeldrisho/pi-vite-plus
```

To try it for one session without installing it:

```bash
pi -e npm:@zeldrisho/pi-vite-plus
```

When Pi's `bash` tool is active, the extension adds concise guidance to use the `vp` CLI.

The extension asks the user to approve detected direct npm, pnpm, and Bun commands before they run, including benign commands. Calls are blocked when confirmation is declined or unavailable. Yarn and direct development-tool commands remain available. Detection is a best-effort confirmation guard, not a shell sandbox.

## Update

```bash
pi update npm:@zeldrisho/pi-vite-plus
```

## Uninstall

```bash
pi remove npm:@zeldrisho/pi-vite-plus
```

## License

[MIT](LICENSE)
