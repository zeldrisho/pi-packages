# @zeldrisho/pi-file-remove

Pi extension that guides coding agents to use [`gomi`](https://github.com/b4b4r07/gomi) for recoverable file and directory removal on the user's local development machine.

## Install

On the user's local development machine, install `gomi` and ensure it is available on the user's `PATH`. Then install the package:

```bash
pi install npm:@zeldrisho/pi-file-remove
```

Install only for the current project:

```bash
pi install -l npm:@zeldrisho/pi-file-remove
```

When Pi's `bash` tool is active, the extension adds concise guidance to use `gomi` instead of `rm` locally and the existing removal workflow in CI, containers, or production.

`gomi` moves removed files and directories to trash so they can be restored.

The extension provides prompt guidance only. It does not intercept or block tool calls.

## Uninstall

```bash
pi remove npm:@zeldrisho/pi-file-remove
```

For a project-local installation:

```bash
pi remove -l npm:@zeldrisho/pi-file-remove
```

## License

[MIT](LICENSE)
