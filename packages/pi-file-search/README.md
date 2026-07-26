# @zeldrisho/pi-file-search

Pi extension that guides coding agents to use [`fd`](https://github.com/sharkdp/fd) for file and directory discovery instead of `find` by default.

## Install

Install `fd` and ensure it is available on your `PATH`, then install the package:

```bash
pi install npm:@zeldrisho/pi-file-search
```

When Pi's `bash` tool is active, the extension adds concise guidance to use `fd` instead of `find` by default.

The extension provides prompt guidance only. It does not intercept or block tool calls.

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
