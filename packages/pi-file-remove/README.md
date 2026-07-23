# @zeldrisho/pi-file-remove

Pi extension that guides coding agents to use [`gomi`](https://github.com/b4b4r07/gomi) for recoverable removal and asks for confirmation before `rm` commands run.

## Install

Install `gomi` and ensure it is available on your `PATH`, then install the package:

```bash
pi install npm:@zeldrisho/pi-file-remove
```

When Pi's `bash` tool is active, the extension:

- guides agents to use `gomi` for recoverable file and directory removal;
- asks the user to approve detected `rm` commands before they run; and
- blocks detected `rm` commands when confirmation is declined or unavailable.

`gomi` accepts file and directory paths similarly to `rm`, but moves removed items to trash so they can be restored.

The command detector recognizes common direct `rm` forms, including `command rm`, `sudo rm`, and absolute paths. It is a best-effort safety guard, not a shell sandbox.

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
