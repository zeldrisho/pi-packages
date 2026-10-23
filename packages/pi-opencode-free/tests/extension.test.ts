import type {
  Model,
  ModelsPublication,
  ModelsStoreEntry,
  ProviderHeaders,
  RefreshModelsContext,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";

import piOpencodeFree, {
  PROVIDER_ID,
  registerOpencodeFree,
  type OpencodeFreeDependencies,
} from "../src/index";
import { DEFAULT_CLI_VERSION, FINGERPRINT_MARKER_HEADER, buildUserAgent } from "../src/fingerprint";
import { MODELS_DEV_URL, initialFreeModels } from "../src/models";
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

type FakeHandler = (event: FakeEvent, context: FakeContext) => ProviderRequestPayload | void;

interface FakePiState {
  provider?: {
    name: string;
    config: ProviderConfig;
  };
  handlers: Map<string, FakeHandler>;
}

interface FakePi {
  pi: ExtensionAPI;
  state: FakePiState;
}

function createFakePi(): FakePi {
  const state: FakePiState = { handlers: new Map() };

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

        return undefined;
      },
    },
  );

  // SAFETY: the proxy supplies the two ExtensionAPI members this extension uses.
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

function dependencies(
  environment: Record<string, string | undefined>,
  fetcher: typeof fetch,
): OpencodeFreeDependencies {
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

const discoveryCatalog = {
  opencode: {
    models: {
      "beam-free": {
        id: "beam-free",
        name: "Beam Free",
        tool_call: true,
        modalities: { input: ["text"], output: ["text"] },
        limit: { context: 128_000, output: 16_384 },
        cost: { input: 0, output: 0 },
      },
      "deepseek-v4.1-flash-free": {
        id: "deepseek-v4.1-flash-free",
        name: "DeepSeek V4.1 Flash Free",
        tool_call: true,
        reasoning: true,
        interleaved: { field: "reasoning_content" },
        modalities: { input: ["text"], output: ["text"] },
        limit: { context: 200_000, output: 32_000 },
        cost: { input: 0, output: 0 },
      },
      "paid-model": { id: "paid-model", cost: { input: 1, output: 1 } },
    },
  },
};

function discoveryFetcher(calls: string[]): typeof fetch {
  return async (input) => {
    const url = input instanceof Request ? input.url : input.toString();

    calls.push(url);

    if (url === MODELS_DEV_URL) return jsonResponse(JSON.stringify(discoveryCatalog));

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

    const config = state.provider?.config;
    expect(config?.name).toBe("OpenCode Free");
    expect(config?.api).toBe("openai-completions");
    expect(config?.apiKey).toBe("public");
    expect(config?.authHeader).toBe(true);
    expect(config?.baseUrl).toBe("https://opencode.ai/inference/v1");
    expect(config?.headers?.[FINGERPRINT_MARKER_HEADER]).toBe("1");
    expect(config?.headers?.["User-Agent"]).toBe(buildUserAgent(DEFAULT_CLI_VERSION));
    expect(config?.headers?.["x-opencode-session"]).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/u);

    const ids = config?.models?.map((model) => model.id) ?? [];
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).toContain("big-pickle");
    expect(ids).not.toContain("jev-1.13-free");

    expect(state.handlers.has("session_start")).toBe(true);
    expect(state.handlers.has("before_provider_headers")).toBe(true);
    expect(state.handlers.has("before_provider_request")).toBe(true);
  });

  it("honors proxy, credential, and client version overrides", () => {
    const { pi, state } = createFakePi();

    registerOpencodeFree(
      pi,
      dependencies(
        {
          OPENCODE_FREE_BASE_URL: " http://localhost:8080/v1/ ",
          OPENCODE_FREE_API_KEY: " secret ",
          OPENCODE_FREE_CLI_VERSION: " 2.1.3 ",
        },
        () => {
          throw new Error("unexpected network access");
        },
      ),
    );

    const config = state.provider?.config;
    expect(config?.baseUrl).toBe("http://localhost:8080/v1");
    expect(config?.apiKey).toBe("secret");
    expect(config?.headers?.["User-Agent"]).toBe("opencode/latest/2.1.3/cli");

    const headers: ProviderHeaders = { ...config?.headers };
    handlerFor(state, "before_provider_headers")({ type: "before_provider_headers", headers }, {});
    expect(headers["User-Agent"]).toBe("opencode/latest/2.1.3/cli");
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
    expect(calls).toEqual(["http://proxy.test/v1/models", MODELS_DEV_URL]);

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

  it("rotates the canonical session id when a session starts", () => {
    const { pi, state } = createFakePi();

    registerOpencodeFree(
      pi,
      dependencies({}, () => {
        throw new Error("unexpected network access");
      }),
    );

    const config = state.provider?.config;
    const initial = config?.headers?.["x-opencode-session"];

    expect(initial).toBeDefined();

    const headers: ProviderHeaders = { ...config?.headers };
    const before = handlerFor(state, "before_provider_headers");

    before({ type: "before_provider_headers", headers }, {});
    expect(headers["x-opencode-session"]).toBe(initial);

    handlerFor(state, "session_start")({ type: "session_start" }, {});
    before({ type: "before_provider_headers", headers }, {});

    expect(headers["x-opencode-session"]).not.toBe(initial);
    expect(headers["x-opencode-session"]).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/u);
  });

  it("normalizes only requests for its own provider", () => {
    const { pi, state } = createFakePi();

    registerOpencodeFree(
      pi,
      dependencies({}, () => {
        throw new Error("unexpected network access");
      }),
    );

    const request = handlerFor(state, "before_provider_request");

    const payload: ProviderRequestPayload = {
      model: "big-pickle",
      stream: false,
      tools: [],
      tool_choice: "none",
      temperature: 0.1,
    };

    const otherProvider = request(
      { type: "before_provider_request", payload },
      { model: { provider: "opencode" } },
    );

    expect(otherProvider).toBeUndefined();

    const invalid = request(
      { type: "before_provider_request", payload: null },
      { model: { provider: PROVIDER_ID } },
    );

    expect(invalid).toBeUndefined();

    const result = request(
      { type: "before_provider_request", payload },
      { model: { provider: PROVIDER_ID } },
    );

    expect(result).toMatchObject({
      stream: true,
      temperature: 0.1,
      tools: [{ function: { name: "read" } }],
    });
    expect(JSON.stringify(result)).not.toContain("tool_choice");
  });

  it("provides a default export for Pi", () => {
    const { pi, state } = createFakePi();

    piOpencodeFree(pi);

    expect(state.provider?.name).toBe(PROVIDER_ID);

    const ids = state.provider?.config.models?.map((model) => model.id) ?? [];
    expect(ids.length).toBeGreaterThan(0);
  });
});
