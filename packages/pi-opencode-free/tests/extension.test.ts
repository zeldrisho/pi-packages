import type {
  Model,
  ModelsPublication,
  ModelsStoreEntry,
  ProviderHeaders,
  RefreshModelsContext,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { normalizeContext } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

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

/** Fixed clock so generated identities are deterministic across a test. */
const SESSION_NOW = 1_793_000_000_000;

function dependencies(environment: Record<string, string | undefined>, fetcher: typeof fetch) {
  let seedValue = 0;
  let storedSessionId: string | undefined;

  return {
    randomSeed: () => {
      seedValue += 1;

      return deterministicSeed(seedValue);
    },
    fetcher,
    environment,
    now: () => SESSION_NOW,
    sessionIdOverride: () => undefined,
    sessionStore: {
      load: () => storedSessionId,
      save: (id: string) => {
        storedSessionId = id;
      },
    },
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
  force?: boolean;
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

  if (options.force !== undefined) context.force = options.force;

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
          etag: '"catalog-v1"',
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

  it("reuses the persisted session identity for inference across session starts", async () => {
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
    expect(sessions[1]).toBe(sessions[0]);
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

  describe("catalog refresh caching", () => {
    const start = Date.UTC(2026, 9, 24);
    const ttl = 4 * 60 * 60 * 1000;
    let now: number;

    beforeEach(() => {
      now = start;
      vi.spyOn(Date, "now").mockImplementation(() => now);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    function provider(fetcher: typeof fetch): ProviderConfig {
      const { pi, state } = createFakePi();
      registerOpencodeFree(pi, dependencies({}, fetcher));

      if (!state.provider) throw new Error("missing provider");

      return state.provider.config;
    }

    it("uses fresh persisted models without network or publication, then refreshes at expiry", async () => {
      const calls: string[] = [];
      const config = provider(discoveryFetcher(calls));

      const { context, publications } = refreshContext({
        allowNetwork: true,
        baseUrl: `${DEFAULT_BASE_URL}/`,
        stored: { models: [storedModel], checkedAt: start, lastModified: 0 },
      });

      now += ttl - 1;
      expect((await refreshModels(config, context)).map((model) => model.id)).toEqual([
        "cached-free",
      ]);
      expect(calls).toEqual([]);
      expect(publications).toEqual([]);

      now += 1;
      expect((await refreshModels(config, context)).map((model) => model.id)).toEqual([
        "beam-free",
        "deepseek-v4.1-flash-free",
      ]);
      expect(calls).toEqual([CLI_UPDATE_URL, `${DEFAULT_BASE_URL}/models`, MODEL_CATALOG_URL]);
      expect(publications[0]?.persist?.checkedAt).toBe(now);
    });

    it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, -1, start + 1, start - ttl])(
      "refreshes stored models with an absent, invalid, future, or expired timestamp: %s",
      async (checkedAt) => {
        const calls: string[] = [];
        const config = provider(discoveryFetcher(calls));

        const { context } = refreshContext({
          allowNetwork: true,
          stored: { models: [storedModel], checkedAt, lastModified: 0 },
        });

        await refreshModels(config, context);
        expect(calls).toHaveLength(3);
      },
    );

    it.each([{ models: [] }, { models: [{ ...storedModel, provider: "other" }] }])(
      "does not treat a timestamp without usable models as a fresh catalog: %j",
      async ({ models }) => {
        const calls: string[] = [];
        const config = provider(discoveryFetcher(calls));

        const { context } = refreshContext({
          allowNetwork: true,
          stored: { models, checkedAt: now, lastModified: 0 },
        });

        await refreshModels(config, context);
        expect(calls).toHaveLength(3);
      },
    );

    it.each([false, true])(
      "caches successful discovery in memory even when persistence throws: %s",
      async (publicationFails) => {
        const calls: string[] = [];
        const config = provider(discoveryFetcher(calls));
        const { context, publications } = refreshContext({ allowNetwork: true });

        if (publicationFails) {
          context.publish = async () => {
            throw new Error("storage unavailable");
          };
        }

        const models = await refreshModels(config, context);
        now += ttl - 1;
        expect(await refreshModels(config, context)).toEqual(models);
        expect(calls).toHaveLength(3);
        expect(publications).toHaveLength(publicationFails ? 0 : 1);

        const offline = refreshContext({ allowNetwork: false });
        expect(await refreshModels(config, offline.context)).toEqual(models);

        now += 1;
        await refreshModels(config, context);
        expect(calls).toHaveLength(5);
      },
    );

    it("does not cache a refused publication", async () => {
      const calls: string[] = [];
      const config = provider(discoveryFetcher(calls));
      const { context } = refreshContext({ allowNetwork: true });
      context.publish = async () => false;

      await refreshModels(config, context);
      await refreshModels(config, context);
      expect(calls).toHaveLength(5);
    });

    it("scopes stored and in-memory catalogs to the normalized endpoint", async () => {
      const calls: string[] = [];
      const config = provider(discoveryFetcher(calls));
      const stored = { models: [storedModel], checkedAt: now };

      const { context } = refreshContext({
        allowNetwork: true,
        baseUrl: "https://proxy.test/v1",
        stored,
      });

      await refreshModels(config, context);
      expect(calls).toContain("https://proxy.test/v1/models");

      const sameEndpoint = refreshContext({
        allowNetwork: true,
        baseUrl: "https://proxy.test/v1///",
      });

      await refreshModels(config, sameEndpoint.context);
      expect(calls).toHaveLength(3);

      const otherEndpoint = refreshContext({
        allowNetwork: true,
        baseUrl: "https://other.test/v1",
      });

      await refreshModels(config, otherEndpoint.context);
      expect(calls).toHaveLength(5);
      expect(calls).toContain("https://other.test/v1/models");
    });

    it("does not use another endpoint's stored catalog as a fallback", async () => {
      const config = provider(async () => new Response(null, { status: 503 }));

      const { context } = refreshContext({
        allowNetwork: true,
        baseUrl: "https://proxy.test/v1",
        stored: { models: [storedModel], checkedAt: now },
      });

      expect(await refreshModels(config, context)).toEqual(initialFreeModels());
    });

    it("retains a known catalog and validators on HTTP failure, advancing the four-hour check time", async () => {
      const calls: string[] = [];
      const successfulFetch = discoveryFetcher(calls);
      let failed = false;

      const config = provider(async (input, init) => {
        const response = await successfulFetch(input, init);

        return failed && input !== CLI_UPDATE_URL ? new Response(null, { status: 503 }) : response;
      });

      const { context, publications } = refreshContext({ allowNetwork: true });
      const models = await refreshModels(config, context);
      const previous = publications[0]?.persist;
      now += ttl;
      failed = true;
      await expect(refreshModels(config, context)).rejects.toThrow("HTTP 503");
      expect(publications[1]?.persist).toEqual({ ...previous, checkedAt: now });
      expect(calls).toHaveLength(5);
      now += ttl - 1;
      expect(await refreshModels(config, context)).toEqual(models);
      expect(calls).toHaveLength(5);

      failed = false;
      now += 1;
      await refreshModels(config, context);
      expect(calls).toHaveLength(7);
    });

    it("does not throttle an initial HTTP failure without Last-Modified metadata", async () => {
      const calls: string[] = [];
      const successfulFetch = discoveryFetcher(calls);

      const config = provider(async (input, init) => {
        const response = await successfulFetch(input, init);

        return input === MODEL_CATALOG_URL ? new Response(null, { status: 503 }) : response;
      });

      const { context, publications } = refreshContext({ allowNetwork: true });

      await expect(refreshModels(config, context)).rejects.toThrow("HTTP 503");
      expect(publications[0]?.persist).toEqual({ models: [], checkedAt: now });
      await expect(refreshModels(config, context)).rejects.toThrow("HTTP 503");
      expect(calls).toHaveLength(5);
    });

    it("revalidates persisted metadata after restart and applies live changes on 304", async () => {
      const calls: string[] = [];
      const successfulFetch = discoveryFetcher(calls);
      const catalogHeaders: Headers[] = [];
      const lastModified = "Wed, 21 Oct 2099 07:28:00 GMT";
      let unchanged = false;

      const fetcher: typeof fetch = async (input, init) => {
        const response = await successfulFetch(input, init);

        if (input === MODEL_CATALOG_URL) {
          catalogHeaders.push(new Headers(init?.headers));

          return unchanged
            ? new Response(null, { status: 304 })
            : Response.json(
                [...discoveryCatalog, { ...discoveryCatalog[0], id: "newly-live-free" }],
                { headers: { "last-modified": lastModified, etag: '"catalog-v1"' } },
              );
        }

        return unchanged && input === `${DEFAULT_BASE_URL}/models`
          ? Response.json({ data: [{ id: "newly-live-free" }] })
          : response;
      };

      const initial = refreshContext({ allowNetwork: true });
      const models = await refreshModels(provider(fetcher), initial.context);
      expect(models.map((model) => model.id)).not.toContain("newly-live-free");
      const stored = initial.publications[0]?.persist;

      if (!stored) throw new Error("missing persisted catalog");

      unchanged = true;
      now += ttl;
      const restarted = refreshContext({ allowNetwork: true, stored });
      const refreshed = await refreshModels(provider(fetcher), restarted.context);
      expect(refreshed.map((model) => model.id)).toEqual(["newly-live-free"]);
      expect(catalogHeaders[0]?.get("if-none-match")).toBeNull();
      expect(catalogHeaders[1]?.get("if-none-match")).toBe('"catalog-v1"');
      expect(catalogHeaders[1]?.get("authorization")).toBeNull();
      expect(catalogHeaders[1]?.get("x-opencode-session")).toBeNull();
      expect(restarted.publications[0]?.persist).toMatchObject({
        checkedAt: now,
        lastModified: Date.parse(lastModified),
        etag: '"catalog-v1"',
      });
    });

    it("does not send an ETag without a complete cached metadata body", async () => {
      const calls: string[] = [];
      const successfulFetch = discoveryFetcher(calls);

      const config = provider(async (input, init) => {
        if (input === MODEL_CATALOG_URL) {
          expect(new Headers(init?.headers).get("if-none-match")).toBeNull();
        }

        return successfulFetch(input, init);
      });

      const { context } = refreshContext({
        allowNetwork: true,
        stored: {
          models: [storedModel],
          checkedAt: start - ttl,
          lastModified: 0,
          etag: '"orphaned"',
        },
      });

      await refreshModels(config, context);
      expect(calls).toHaveLength(3);
    });

    it.each([404, 501])("persists native missing-catalog markers for HTTP %s", async (status) => {
      const calls: string[] = [];
      const successfulFetch = discoveryFetcher(calls);
      const builtin = initialFreeModels()[0];

      if (!builtin) throw new Error("missing bundled model");

      const config = provider(async (input, init) => {
        const response = await successfulFetch(input, init);

        if (input === MODEL_CATALOG_URL) return new Response(null, { status });

        return input === `${DEFAULT_BASE_URL}/models`
          ? Response.json({ data: [{ id: builtin.id }] })
          : response;
      });

      const { context, publications } = refreshContext({ allowNetwork: true });
      expect(await refreshModels(config, context)).toEqual([builtin]);
      expect(publications[0]?.persist).toMatchObject({ lastModified: 0, checkedAt: now });
      expect(publications[0]?.persist?.etag).toBeUndefined();
      now += ttl - 1;
      await refreshModels(config, context);
      expect(calls).toHaveLength(3);
    });

    it.each(["transport", "invalid-json"])(
      "does not advance freshness on catalog %s failures",
      async (failure) => {
        const calls: string[] = [];
        const successfulFetch = discoveryFetcher(calls);

        const config = provider(async (input, init) => {
          const response = await successfulFetch(input, init);

          if (input === MODEL_CATALOG_URL) {
            if (failure === "transport") throw new Error("private details");

            return new Response("{");
          }

          return response;
        });

        const { context, publications } = refreshContext({
          allowNetwork: true,
          stored: { models: [storedModel], checkedAt: start - ttl, lastModified: 0 },
        });

        expect((await refreshModels(config, context))[0]?.id).toBe("cached-free");
        await refreshModels(config, context);
        expect(calls).toHaveLength(5);
        expect(publications).toEqual([]);
      },
    );

    it("rechecks legacy snapshots without Last-Modified instead of trusting checkedAt alone", async () => {
      const calls: string[] = [];
      const config = provider(discoveryFetcher(calls));

      const { context } = refreshContext({
        allowNetwork: true,
        stored: { models: [storedModel], checkedAt: now },
      });

      await refreshModels(config, context);
      expect(calls).toHaveLength(3);
    });

    it("does not cache CLI-version lookup failures or advance freshness", async () => {
      const calls: string[] = [];

      const config = provider(async (input) => {
        calls.push(new Request(input).url);

        return new Response(null, { status: 503 });
      });

      const { context, publications } = refreshContext({ allowNetwork: true });

      await refreshModels(config, context);
      await refreshModels(config, context);
      expect(calls).toEqual([CLI_UPDATE_URL, CLI_NPM_URL, CLI_UPDATE_URL, CLI_NPM_URL]);
      expect(publications).toEqual([]);
    });

    it("allows force to bypass successful and failed HTTP freshness checks", async () => {
      const calls: string[] = [];
      const successfulFetch = discoveryFetcher(calls);
      let failed = false;

      const config = provider(async (input, init) => {
        const response = await successfulFetch(input, init);

        return failed && input !== CLI_UPDATE_URL ? new Response(null, { status: 503 }) : response;
      });

      const { context } = refreshContext({ allowNetwork: true, force: true });

      await refreshModels(config, context);
      failed = true;
      await expect(refreshModels(config, context)).rejects.toThrow("HTTP 503");
      expect(calls).toHaveLength(5);
      failed = false;
      await refreshModels(config, context);
      expect(calls).toHaveLength(7);
    });

    it.each(["offline", "aborted"])("never lets force override %s mode", async (mode) => {
      const calls: string[] = [];
      const config = provider(discoveryFetcher(calls));

      const { context } = refreshContext({
        allowNetwork: mode !== "offline",
        force: true,
        signal: mode === "aborted" ? AbortSignal.abort() : undefined,
      });

      expect(await refreshModels(config, context)).toEqual(initialFreeModels());
      expect(calls).toEqual([]);
    });

    it("does not advance freshness after caller cancellation during discovery", async () => {
      const calls: string[] = [];
      const successfulFetch = discoveryFetcher(calls);
      const controller = new AbortController();

      const config = provider(async (input, init) => {
        if (input === `${DEFAULT_BASE_URL}/models`) controller.abort();

        return successfulFetch(input, init);
      });

      const canceled = refreshContext({ allowNetwork: true, signal: controller.signal });

      expect(await refreshModels(config, canceled.context)).toEqual(initialFreeModels());
      expect(canceled.publications).toEqual([]);
      const retry = refreshContext({ allowNetwork: true });
      await refreshModels(config, retry.context);
      expect(calls).toHaveLength(5);
      expect(retry.publications).toHaveLength(1);
    });

    it("does not advance freshness after caller cancellation during version resolution", async () => {
      const calls: string[] = [];
      const successfulFetch = discoveryFetcher(calls);
      const controller = new AbortController();

      const config = provider(async (input, init) => {
        if (input === CLI_UPDATE_URL) controller.abort();

        return successfulFetch(input, init);
      });

      const canceled = refreshContext({ allowNetwork: true, signal: controller.signal });

      expect(await refreshModels(config, canceled.context)).toEqual(initialFreeModels());
      expect(calls).toEqual([CLI_UPDATE_URL]);
      const retry = refreshContext({ allowNetwork: true });
      await refreshModels(config, retry.context);
      expect(calls).toEqual([
        CLI_UPDATE_URL,
        CLI_UPDATE_URL,
        `${DEFAULT_BASE_URL}/models`,
        MODEL_CATALOG_URL,
      ]);
      expect(retry.publications).toHaveLength(1);
    });

    it("does not advance freshness after deadline failures", async () => {
      const calls: string[] = [];
      const successfulFetch = discoveryFetcher(calls);
      const deadline = new AbortController();
      const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);

      const config = provider(async (input, init) => {
        if (input === `${DEFAULT_BASE_URL}/models`) {
          deadline.abort(new DOMException("deadline", "TimeoutError"));
        }

        return successfulFetch(input, init);
      });

      const { context, publications } = refreshContext({ allowNetwork: true });

      expect(await refreshModels(config, context)).toEqual(initialFreeModels());
      expect(publications).toEqual([]);
      timeout.mockRestore();
      await refreshModels(config, context);
      expect(calls).toHaveLength(5);
      expect(publications).toHaveLength(1);

      const otherEndpoint = refreshContext({
        allowNetwork: true,
        baseUrl: "https://proxy.test/v1",
      });

      await refreshModels(config, otherEndpoint.context);
      expect(calls).toHaveLength(7);
      expect(otherEndpoint.publications).toHaveLength(1);
    });
  });

  it("provides a default export for Pi", () => {
    const { pi, state } = createFakePi();

    piOpencodeFree(pi);

    expect(state.provider?.name).toBe(PROVIDER_ID);

    const ids = state.provider?.config.models?.map((model) => model.id) ?? [];
    expect(ids.length).toBeGreaterThan(0);
  });
});
