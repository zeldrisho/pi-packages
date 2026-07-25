# @zeldrisho/pi-file-search

Pi extension that guides coding agents to use [`fd`](https://github.com/sharkdp/fd) for file and directory discovery.

## Install

Install `fd` and ensure it is available on your `PATH`, then install the package:

```bash
pi install npm:@zeldrisho/pi-file-search
```

When Pi's `bash` tool is active, the extension adds concise `fd` guidance. The extension asks the user to approve the built-in `find` tool and detected direct `find` shell commands before they run, including benign searches. Calls are blocked when confirmation is declined or unavailable.

Command detection is a best-effort confirmation guard, not a shell sandbox.

## Update

```bash
pi update npm:@zeldrisho/pi-file-search
```

## Uninstall

```bash
pi remove npm:@zeldrisho/pi-file-search
```

## License

[MIT](LICENSE)
