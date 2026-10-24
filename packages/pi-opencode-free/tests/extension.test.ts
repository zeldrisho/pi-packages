import type {
  Model,
  ModelsPublication,
  ModelsStoreEntry,
  ProviderHeaders,
  RefreshModelsContext,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { normalizeContext } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vite-plus/test";

import piOpencodeFree, { PROVIDER_ID, registerOpencodeFree } from "../src/index";
import { CLI_NPM_URL, CLI_UPDATE_URL } from "../src/cli-version";
import { FINGERPRINT_MARKER_HEADER } from "../src/fingerprint";
import { DEFAULT_BASE_URL, MODEL_CATALOG_URL, initialFreeModels } from "../src/models";
import type { ProviderRequestPayload } from "../src/request";

interface FakeEvent {
  type: string;
  payload?: ProviderRequestPayload | null;
  headers?: ProviderHeaders;
}

interface FakeContext {
  model?: {
    provider: string;
  };
}

type FakeHandler = (event: FakeEvent, context: FakeContext) => void | Promise<void>;

interface FakePiState {
  provider?: {
    name: string;
    config: ProviderConfig;
  };
  handlers: Map<string, FakeHandler>;
  commands: Set<string>;
}

interface FakePi {
  pi: ExtensionAPI;
  state: FakePiState;
}

function createFakePi(): FakePi {
  const state: FakePiState = { handlers: new Map(), commands: new Set() };

  const proxy = new Proxy(
    {},
    {
      get(_target, property) {
        if (property === "registerProvider") {
          return (name: string, config: ProviderConfig): void => {
            state.provider = { name, config };
          };
        }

        if (property === "on") {
          return (event: string, handler: FakeHandler): (() => void) => {
            state.handlers.set(event, handler);

            return () => {
              state.handlers.delete(event);
            };
          };
        }

        if (property === "registerCommand") {
          return (name: string): void => {
            state.commands.add(name);
          };
        }

        return undefined;
      },
    },
  );

  // SAFETY: the proxy supplies the ExtensionAPI members this extension uses.
  return { pi: proxy as ExtensionAPI, state };
}

function handlerFor(state: FakePiState, event: string): FakeHandler {
  const handler = state.handlers.get(event);

  if (!handler) throw new Error(`Missing ${event} handler`);

  return handler;
}

function deterministicSeed(value: number): Uint8Array {
  return Uint8Array.from({ length: 20 }, (_, index) => (index + value) % 256);
}

function dependencies(environment: Record<string, string | undefined>, fetcher: typeof fetch) {
  let seedValue = 0;

  return {
    randomSeed: () => {
      seedValue += 1;

      return deterministicSeed(seedValue);
    },
    fetcher,
    environment,
  };
}

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface RefreshHarness {
  context: RefreshModelsContext;
  publications: ModelsPublication[];
}

function refreshContext(options: {
  allowNetwork: boolean;
  stored?: ModelsStoreEntry;
  baseUrl?: string;
  signal?: AbortSignal;
}): RefreshHarness {
  const publications: ModelsPublication[] = [];

  const context: RefreshModelsContext = {
    allowNetwork: options.allowNetwork,
    signal: options.signal ?? new AbortController().signal,
    publish: async (publication) => {
      publications.push(publication);

      return true;
    },
  };

  if (options.stored) context.stored = options.stored;

  if (options.baseUrl) context.baseUrl = options.baseUrl;

  return { publications, context };
}

async function refreshModels(config: ProviderConfig, context: RefreshModelsContext) {
  if (!config.refreshModels) throw new Error("missing refreshModels");

  return config.refreshModels(context);
}

const storedModel: Model<"openai-completions"> = {
  id: "cached-free",
  name: "Cached Free",
  provider: PROVIDER_ID,
  api: "openai-completions",
  baseUrl: "https://opencode.ai/inference/v1",
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 64_000,
  maxTokens: 8_000,
  reasoning: false,
};

const discoveryCatalog = [
  {
    id: "beam-free",
    name: "Beam Free",
    provider: "opencode",
    api: "openai-completions",
    baseUrl: "https://opencode.ai/inference/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 131_072,
  },
  {
    id: "deepseek-v4.1-flash-free",
    name: "DeepSeek V4.1 Flash Free",
    provider: "opencode",
    api: "openai-completions",
    baseUrl: "https://opencode.ai/inference/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 32_000,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsStrictMode: true,
      maxTokensField: "max_tokens",
      requiresReasoningContentOnAssistantMessages: true,
    },
  },
  {
    id: "paid-model",
    provider: "opencode",
    api: "openai-completions",
    input: ["text"],
    cost: { input: 1, output: 1 },
    contextWindow: 100_000,
    maxTokens: 10_000,
    reasoning: false,
  },
];

function versionResponse(): Response {
  return Response.json({
    channel: "latest",
    name: "cli",
    distribution: "npm",
    active: true,
    version: "2.1.4",
    metadata: { package: "@opencode/cli" },
  });
}

function discoveryFetcher(calls: string[]): typeof fetch {
  return async (input) => {
    const url = input instanceof Request ? input.url : input.toString();

    calls.push(url);

    if (url === CLI_UPDATE_URL) return versionResponse();

    if (url === MODEL_CATALOG_URL) {
      return new Response(JSON.stringify(discoveryCatalog), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "last-modified": "Wed, 21 Oct 2099 07:28:00 GMT",
        },
      });
    }

    if (url.endsWith("/models")) {
      return jsonResponse(
        JSON.stringify({
          data: [{ id: "beam-free" }, { id: "deepseek-v4.1-flash-free" }, { id: "paid-model" }],
        }),
      );
    }

    return jsonResponse("not found", 404);
  };
}

describe("opencode-free extension", () => {
  it("registers the provider, hooks, and initial models", () => {
    const { pi, state } = createFakePi();

    registerOpencodeFree(
      pi,
      dependencies({}, () => {
        throw new Error("unexpected network access");
      }),
    );

    expect(state.provider?.name).toBe(PROVIDER_ID);
    expect(state.commands.size).toBe(0);

    const config = state.provider?.config;
    expect(config?.name).toBe("OpenCode Free");
    expect(config?.api).toBe("openai-completions");
    expect(config?.apiKey).toBe("public");
    expect(config?.authHeader).toBe(true);
    expect(config?.baseUrl).toBe("https://opencode.ai/inference/v1");
    expect(config?.headers).toBeUndefined();

    const ids = config?.models?.map((model) => model.id) ?? [];
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).toContain("big-pickle");
    expect(ids).not.toContain("jev-1.13-free");

    expect(state.handlers.has("session_start")).toBe(true);
    expect(config?.streamSimple).toBeDefined();
    expect(state.handlers.has("before_provider_headers")).toBe(false);
    expect(state.handlers.has("before_provider_request")).toBe(false);
  });

  it.each([
    { OPENCODE_FREE_BASE_URL: " http://localhost:8080/v1/ " },
    { OPENCODE_FREE_API_KEY: " secret " },
    { OPENCODE_API_KEY: " paid " },
    { OPENCODE_FREE_CLI_VERSION: "2.999.0" },
    {
      OPENCODE_FREE_BASE_URL: " http://localhost:8080/v1/ ",
      OPENCODE_FREE_API_KEY: " secret ",
      OPENCODE_API_KEY: " paid ",
    },
  ])("ignores removed environment overrides: %j", async (environment) => {
    const { pi, state } = createFakePi();
    const calls: string[] = [];

    registerOpencodeFree(pi, dependencies(environment, discoveryFetcher(calls)));

    const config = state.provider?.config;

    if (!config) throw new Error("missing provider");

    expect(config.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(config.apiKey).toBe("public");
    expect(config.authHeader).toBe(true);

    const { context } = refreshContext({ allowNetwork: true });
    await refreshModels(config, context);
    expect(calls).toEqual([CLI_UPDATE_URL, `${DEFAULT_BASE_URL}/models`, MODEL_CATALOG_URL]);
  });

  it("refreshes models through the injected fetcher and persists the catalog", async () => {
    const { pi, state } = createFakePi();
    const calls: string[] = [];

    registerOpencodeFree(pi, dependencies({}, discoveryFetcher(calls)));

    const config = state.provider?.config;

    if (!config) throw new Error("missing provider");

    const { context, publications } = refreshContext({
      allowNetwork: true,
      baseUrl: "http://proxy.test/v1",
    });

    const models = await refreshModels(config, context);

    expect(models.map((model) => model.id)).toEqual(["beam-free", "deepseek-v4.1-flash-free"]);
    expect(calls).toEqual([CLI_UPDATE_URL, "http://proxy.test/v1/models", MODEL_CATALOG_URL]);

    expect(publications).toHaveLength(1);

    const persisted = publications[0]?.persist;
    expect(persisted?.models).toHaveLength(2);
    expect(persisted?.checkedAt).toBeGreaterThan(0);
    expect(persisted?.models[0]).toMatchObject({
      id: "beam-free",
      provider: PROVIDER_ID,
      api: "openai-completions",
      baseUrl: "http://proxy.test/v1",
    });
  });

  it("uses stored models without touching the network when offline", async () => {
    const { pi, state } = createFakePi();

    registerOpencodeFree(
      pi,
      dependencies({}, () => {
        throw new Error("unexpected network access");
      }),
    );

    const config = state.provider?.config;

    if (!config) throw new Error("missing provider");

    const { context, publications } = refreshContext({
      allowNetwork: false,
      stored: { models: [storedModel] },
    });

    const models = await refreshModels(config, context);

    expect(models).toEqual([
      {
        id: "cached-free",
        name: "Cached Free",
        input: ["text"],
        cost: storedModel.cost,
        contextWindow: 64_000,
        maxTokens: 8_000,
        reasoning: false,
      },
    ]);
    expect(publications).toHaveLength(0);
  });

  it("falls back to built-in models when offline without a stored catalog", async () => {
    const { pi, state } = createFakePi();
    const calls: string[] = [];

    registerOpencodeFree(pi, dependencies({}, discoveryFetcher(calls)));

    const config = state.provider?.config;

    if (!config) throw new Error("missing provider");

    const { context } = refreshContext({ allowNetwork: false });
    const models = await refreshModels(config, context);

    expect(models.map((model) => model.id)).toEqual(initialFreeModels().map((model) => model.id));
    expect(calls).toHaveLength(0);
  });

  it("keeps the stored catalog when discovery fails", async () => {
    const { pi, state } = createFakePi();

    registerOpencodeFree(
      pi,
      dependencies({}, async () => jsonResponse("unavailable", 503)),
    );

    const config = state.provider?.config;

    if (!config) throw new Error("missing provider");

    const { context, publications } = refreshContext({
      allowNetwork: true,
      stored: { models: [storedModel] },
    });

    const models = await refreshModels(config, context);

    expect(models.map((model) => model.id)).toEqual(["cached-free"]);
    expect(publications).toHaveLength(0);
  });

  it("rotates session identity for inference, including requests without extension hooks", async () => {
    const { pi, state } = createFakePi();
    const sessions: Array<string | null> = [];
    let versionLookups = 0;
    registerOpencodeFree(
      pi,
      dependencies({}, async (input, init) => {
        if (input === CLI_UPDATE_URL) {
          versionLookups += 1;

          return versionResponse();
        }

        const headers = new Headers(init?.headers);
        sessions.push(headers.get("x-opencode-session"));
        expect(headers.get("User-Agent")).toBe("opencode/latest/2.1.4/cli");
        expect(headers.get("Authorization")).toBe("Bearer public");
        expect(headers.get(FINGERPRINT_MARKER_HEADER)).toBe("1");

        return new Response(
          JSON.stringify({
            type: "error",
            error: { type: "FreeUsageLimitError", message: "Free usage limit reached" },
          }),
          {
            status: 429,
            headers: { "content-type": "application/json", "retry-after": "3600" },
          },
        );
      }),
    );
    const config = state.provider?.config;
    const native = config?.streamSimple;

    if (!config || !native) throw new Error("missing provider stream");

    const context = normalizeContext({
      messages: [{ role: "user", content: "Summarize", timestamp: 0 }],
    });

    await native(storedModel, context, { apiKey: "public", maxRetries: 0 }).result();
    expect(sessions[0]).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/u);
    await handlerFor(state, "session_start")({ type: "session_start" }, {});
    await native(storedModel, context, { apiKey: "public", maxRetries: 0 }).result();
    expect(sessions[1]).not.toBe(sessions[0]);
    expect(sessions[1]).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/u);
    expect(sessions).toHaveLength(2);
    expect(versionLookups).toBe(1);
  });

  it("reports a version lookup failure without sending an inference request", async () => {
    const { pi, state } = createFakePi();
    const calls: string[] = [];
    registerOpencodeFree(
      pi,
      dependencies({}, async (input) => {
        calls.push(new Request(input).url);

        return new Response("unavailable", { status: 503 });
      }),
    );
    const native = state.provider?.config.streamSimple;

    if (!native) throw new Error("missing provider stream");

    const context = normalizeContext({ messages: [{ role: "user", content: "Hi", timestamp: 0 }] });
    const result = await native(storedModel, context, { apiKey: "public", maxRetries: 0 }).result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("Cannot resolve the current OpenCode CLI version");
    expect(calls).toEqual([CLI_UPDATE_URL, CLI_NPM_URL]);
  });

  it("provides a default export for Pi", () => {
    const { pi, state } = createFakePi();

    piOpencodeFree(pi);

    expect(state.provider?.name).toBe(PROVIDER_ID);

    const ids = state.provider?.config.models?.map((model) => model.id) ?? [];
    expect(ids.length).toBeGreaterThan(0);
  });
});
