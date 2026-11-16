# pi-antigravity

Implementation and maintenance notes for `@zeldrisho/pi-antigravity`. The package README covers usage; this file covers the protocol the extension speaks and how to keep it working.

## Shape

`packages/pi-antigravity/src/` is split by concern:

| File                  | Responsibility                                                          |
| --------------------- | ----------------------------------------------------------------------- |
| `index.ts`            | `registerProvider()`, OAuth hooks, `refreshModels` publication          |
| `oauth.ts`            | Google OAuth (PKCE), token refresh, API-key encoding, loopback callback |
| `project.ts`          | Endpoints, request headers, `loadCodeAssist` project discovery          |
| `discovery.ts`        | `fetchAvailableModels` catalog refresh and runtime-variant grouping     |
| `models.ts`           | Fallback catalog, runtime-model routing, thinking configuration         |
| `budget-overrides.ts` | Pi budgets for discovered single-route token-budget models              |
| `pi-catalog.ts`       | Bounded pi.dev Google and Vertex metadata with bundled fallback         |
| `request.ts`          | Transcript → `v1internal` envelope, tool-schema normalization           |
| `stream.ts`           | SSE consumption, endpoint fallback, retries, Pi event emission          |
| `cli-version.ts`      | Bundled `User-Agent` version and platform tokens                        |
| `agy-client.ts`       | Bounded local OAuth client discovery from the installed CLI binary      |
| `json.ts`             | JSON boundary helpers shared by the modules above                       |

## Wire protocol

Requests go to `POST {endpoint}/v1internal:streamGenerateContent?alt=sse` with an OAuth bearer token and an envelope carrying `project`, `model`, `requestId`, and a Gemini-shaped `request`. The `sessionId` and `labels` fields belong inside `request`. Endpoints are tried in order (`daily-cloudcode-pa`, then `cloudcode-pa`); a `429` moves to the next endpoint, other failures are reported.

Two model families need different payloads:

- Gemini 3 and newer reject replayed tool calls without a thought signature, so unsigned history becomes observation text instead.
- Claude and GPT-OSS use the legacy tool-schema subset and tool-call ids.

Both rules live in `request.ts` and are covered by `tests/request.test.ts`.

Some exact phrases in Pi's default system prompt have produced generic 429 responses from the backend despite available quota. `compatibleSystemPrompt` rephrases the default preamble and one documentation phrase only when the prompt begins with Pi's exact default preamble. It preserves the remaining instructions and leaves prompts with a different preamble unchanged; this is a compatibility workaround, not a guarantee against quota or capacity errors.

## Model discovery

The catalog is not hardcoded. `refreshModels` calls `POST {endpoint}/v1internal:fetchAvailableModels` with `{ project }` and builds Pi's model list from the response:

- Runtime ids are grouped into public models by their thinking suffix (`-low`, `-medium`, `-high`, `-thinking`, `-xhigh`, `-extra-low`, `-extra-high`, `-minimal`), with a display-name parenthetical (`Gemini 3.8 Flash (High)`) as the fallback signal.
- When present, `agentModelSorts[].groups[].modelIds[]` restricts the catalog to what the backend recommends for the account. A non-matching list falls back to the stored or seed catalog, not the unfiltered response.
- `maxTokens` becomes the context window, `maxOutputTokens` the output limit, and `supportsThinking`/`supportsImages` decide reasoning and image input. When variants disagree, the smallest limit wins so every route stays valid.
- For exact Gemini IDs, fetch the public pi.dev Google and Vertex chat catalogs during Antigravity refresh, with no credential headers, redirects, or unbounded responses. As in native Pi, a remote catalog overlays bundled metadata only when its Last-Modified is newer than the bundled generation time (or that time is unavailable). Prefer qualifying Google data over qualifying Vertex data, then installed Pi metadata. Intersect thinking levels and image capability with Antigravity's result and use the smaller context/output limits. Missing Pi entries leave discovery unchanged. Pi metadata never adds unavailable routes, changes account availability, or imports API pricing.
- Internal, disabled, image, completion, and `MODEL_*` entries are dropped.

Discovered models and validated Google/Vertex metadata snapshots persist through `context.publish({ persist })` in Pi's model store. Like Pi's native catalog refresh, they are reused for four hours unless a refresh is forced; offline mode and cancellation always take precedence. Each pi.dev catalog has its own ETag and Last-Modified value. Conditional requests require a nonempty cached body; 304 keeps that body, while 404/501 clear it and its validator. Other HTTP failures preserve prior snapshots, advance freshness only when both snapshots exist, and report a bounded status. Transport, timeout and parse failures do not advance freshness. Existing caches without both snapshots refresh on the next online start. Antigravity discovery failure falls back to stored models, then to `FALLBACK_MODELS`.

`modelConfigs()` projects catalog entries into `ProviderModelConfig`, and Pi hands the resulting `Model` back to the stream adapter, so routing travels in `thinkingLevelMap` rather than a private registry. Discovery exposes Pi budget levels when a single runtime advertises a positive token budget. These levels persist in the catalog; existing cache entries update on the next refresh. A configured Pi budget overrides live metadata only for such a runtime; missing or level-based metadata fails closed. It is capped to leave 1,024 output tokens.

## Live checks

- Model list: `agy models` prints the runtime ids and display names the backend serves. `FALLBACK_MODELS` should match it.
- CLI version: `agy --version`, or the Homebrew cask that tracks releases: <https://github.com/Homebrew/homebrew-cask/blob/master/Casks/a/antigravity-cli.rb>. Compare it with `DEFAULT_CLI_VERSION` and update that constant after a cask bump; the extension does not probe the CLI version.

OAuth application discovery scans only the `agy` executable found on PATH, never the `agy` account-token store. It matches known consumer-client fingerprints, rather than guessing a pairing when multiple clients are embedded, and fails closed if the fingerprints are missing or ambiguous. The fingerprints and approach are independently documented by [agy-auth](https://github.com/fikrilal/agy-auth/blob/main/internal/oauth/oauth.go), an MIT-licensed project. A client rotation may require an extension update. The executable must be a native binary or a recognized Homebrew wrapper.

Environment overrides:

| Variable                      | Effect             |
| ----------------------------- | ------------------ |
| `PI_ANTIGRAVITY_REDIRECT_URI` | OAuth redirect URI |

## Unverified against the live backend

These choices are inherited from working clients and covered only by unit tests; check them first if the provider stops working:

- OAuth login with the installed CLI client succeeded in a live test. Google may restrict private scopes or backend access to specific clients.
- The `User-Agent` shape (`antigravity/cli/<version> (...)`) and the `auth_method` token.
- The loopback redirect URI `http://localhost:51121/oauth-callback`. Installed CLI releases use a hosted `antigravity.google/oauth-callback` page with a pasted code. A rejected redirect URI may prevent login; the extension's pasted-URL option does not bypass Google's redirect validation.
- Thinking settings beyond the traced Gemini 3.8 Flash, Claude Sonnet 4.6, Claude Opus 4.6, and GPT-OSS 120B routes. The stream resolves advertised per-runtime thinking levels and budgets from a fresh catalog, caching only validated settings in memory per credential and project for six hours. If unavailable, it uses fallback assumptions; new metadata formats require verification.
- Envelope `requestType`, `userAgent`, and `labels` values, which the backend reads for routing and telemetry.
