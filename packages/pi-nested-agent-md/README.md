# @zeldrisho/pi-nested-agent-md

Pi extension that discovers nested `AGENTS.md` files when Pi reads files in a project.

## Install

```bash
pi install npm:@zeldrisho/pi-nested-agent-md
```

Install only for the current project:

```bash
pi install -l npm:@zeldrisho/pi-nested-agent-md
```

For each successfully read file, the extension finds applicable `AGENTS.md` files between the project root and the file's directory. It injects their instructions from outermost to innermost, excludes the root `AGENTS.md` that Pi already loads, and rejects paths outside the project.

If a discovered `AGENTS.md` exists but cannot be read (for example, due to permissions), the extension appends a visible warning instead of silently skipping it. The file stays eligible and is injected on a later successful read.

Each applicable file is injected only once per session context. Reading an `AGENTS.md` directly also marks it as seen, while session compaction and tree navigation reset deduplication so the instructions can be restored.

## Uninstall

```bash
pi remove npm:@zeldrisho/pi-nested-agent-md
```

For a project-local installation:

```bash
pi remove -l npm:@zeldrisho/pi-nested-agent-md
```

## License

[MIT](LICENSE)
