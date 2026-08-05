# @zeldrisho/pi-cloudflare

Pi extension that keeps coding agents from relying on stale [Cloudflare Workers](https://developers.cloudflare.com/workers/) API knowledge: before any Workers, KV, R2, D1, Durable Objects, Queues, Vectorize, AI, or Agents SDK task, the agent is told to retrieve current documentation and limits.

## Install

```bash
pi install npm:@zeldrisho/pi-cloudflare
```

Install only for the current project:

```bash
pi install -l npm:@zeldrisho/pi-cloudflare
```

To try it for one session without installing it:

```bash
pi -e npm:@zeldrisho/pi-cloudflare
```

## Behavior

While Pi's `bash` tool is active, the extension appends Cloudflare Workers guidance to the system prompt at the start of every agent turn: where the docs and MCP server live, how to look up limits and quotas, the `wrangler` commands, Node.js compatibility, how to diagnose errors, the product documentation index, and best practices for Durable Objects and Workflows.

The guidance is exactly the `AGENTS.md` that [`create-cloudflare`](https://github.com/cloudflare/workers-sdk/tree/main/packages/create-cloudflare) injects into new Workers projects, kept verbatim: retrieval-led guidance for Cloudflare APIs covering docs, limits, `wrangler` commands, Node.js compatibility, errors, the product documentation index, and Durable Objects and Workflows best practices.

The extension provides prompt guidance only. It does not intercept or block tool calls.

## Uninstall

```bash
pi remove npm:@zeldrisho/pi-cloudflare
```

For a project-local installation:

```bash
pi remove -l npm:@zeldrisho/pi-cloudflare
```

## License

[MIT](LICENSE)
