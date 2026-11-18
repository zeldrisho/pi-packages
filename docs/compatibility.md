# Provider compatibility investigations

Use this workflow for upstream changes affecting `pi-antigravity` or `pi-opencode-free`. Inspect only artifacts you are authorized to examine. Do not run downloaded code or inspect account-token stores. Live testing is separate and follows [testing.md](testing.md).

## Capture and compare

The inventory command reads one explicitly selected, regular file without executing it or accessing the network. It reports its size, SHA-256, detected binary format and presence of a small, provider-specific set of literal strings. It does not extract credentials, model lists, values, paths or surrounding text. It accepts files up to 512 MiB.

```bash
node scripts/compatibility.ts capture antigravity /path/to/cli-binary > /private/path/old.json
node scripts/compatibility.ts capture antigravity /path/to/new-cli-binary > /private/path/new.json
vp run compatibility:compare /private/path/old.json /private/path/new.json
```

Use `opencode` for an OpenCode artifact. Capture comparable artifacts: a wrapper and the binary it starts are not equivalent. Store output privately, record the upstream version and origin separately, and remove temporary files when done. The tool does not establish artifact authenticity, extract versions or enumerate models. A hash identifies the bytes inspected; it does not prove provenance. File hashes may themselves be sensitive for private artifacts.

Markers are case-sensitive byte substrings. A hit establishes only that a string exists in the file; a miss does not establish absence of a feature (bundling, compression or alternate spelling can hide it). Comparing identical markers does not prove behavior is unchanged. For deeper inspection, work on a copy, inventory before disassembly, and limit output. Do not publish raw binary strings or credentials.

## Request evidence

Do not intercept system TLS or install a root certificate to inspect provider traffic. Wireshark without decryption sees destinations and timing, not authenticated request contents. For our own extension, use its injectable fetch boundary instead. The recorder below observes only calls made through the supplied fetch function; it does not inspect the upstream CLI or decrypt provider traffic.

```ts
import { createCaptureFetch } from "./scripts/request-capture.ts";
import { registerOpencodeFree } from "./packages/pi-opencode-free/src/index.ts";

const capture = createCaptureFetch(realFetch);
registerOpencodeFree(pi, { fetcher: capture.fetch, randomSeed, sessionStore });
// After the authorized live check:
await writeFile("/private/path/capture.json", JSON.stringify(capture.snapshot()));
```

It records method, sanitized target, explicitly supplied header names and non-sensitive values, request-body shape, status and error occurrence. It omits response bodies and error text. Authorization, cookies, API keys, secret fields and sensitive query values are redacted; long strings are represented by length and SHA-256. Review a snapshot before sharing it, and keep it outside the worktree. A captured `200` establishes a response status, not model entitlement or correctness.

Create an explicit evidence record from sanitized findings:

```bash
node scripts/request-capture.ts evidence 'Does the header exist?' \
  '{"observed":["- Header present in capture"],"inferred":[],"unknown":["- Server enforcement"]}'
```

## Evidence and fixes

Record upstream version, artifact identity, source location, date and limitations. Distinguish static observations from runtime observations and inferences; mark unverified claims unknown. For protocol differences, isolate one variable in an authorized controlled test. Sanitize any evidence and convert confirmed regressions into deterministic fixtures before changing runtime behavior. Preserve the security and regression requirements in [development.md](development.md) and the trust boundaries in [architecture.md](architecture.md).
