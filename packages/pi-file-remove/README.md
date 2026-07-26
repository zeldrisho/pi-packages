# @zeldrisho/pi-file-remove

Pi extension that guides coding agents to use [`gomi`](https://github.com/b4b4r07/gomi) for recoverable file and directory removal on the user's local development machine.

## Install

On the user's local development machine, install `gomi` and ensure it is available on the user's `PATH`. Then install the package:

```bash
pi install npm:@zeldrisho/pi-file-remove
```

When Pi's `bash` tool is active, the extension guides agents to:

- use `gomi`, not `rm`, on the user's local development machine;
- use the existing removal workflow in CI, containers, or production; and
- use `rm` only for user-approved permanent deletion.

`gomi` accepts file and directory paths similarly to `rm`, but moves removed items to trash so they can be restored.

The extension provides prompt guidance only. It does not intercept or block tool calls.

## Update

```bash
pi update npm:@zeldrisho/pi-file-remove
```

## Uninstall

```bash
pi remove npm:@zeldrisho/pi-file-remove
```

## License

[MIT](LICENSE)
