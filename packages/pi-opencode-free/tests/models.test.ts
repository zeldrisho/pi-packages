import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_BASE_URL,
  MODEL_CATALOG_URL,
  configsFromStoredModels,
  discoverFreeModels,
  discoverFreeModelsWithStatus,
  initialFreeModels,
  resolveApiKey,
  resolveBaseUrl,
  storedModelsFromConfigs,
  type FreeChatModelConfig,
} from "../src/models";

interface FetchCall {
  url: string;
  headers: Headers;
  signal: AbortSignal | null | undefined;
}

const FUTURE_LAST_MODIFIED = "Wed, 21 Oct 2099 07:28:00 GMT";

function jsonResponse(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

interface TestFetcher {
  fetcher: typeof fetch;
  calls: FetchCall[];
}

function createFetcher(handler: (url: string) => Response): TestFetcher {
  const calls: FetchCall[] = [];

  const fetcher: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();

    calls.push({ url, headers: new Headers(init?.headers), signal: init?.signal });

    return handler(url);
  };

  return { fetcher, calls };
}

function requireModels(models: FreeChatModelConfig[] | undefined): FreeChatModelConfig[] {
  if (!models) throw new Error("Expected discovered models");

  return models;
}

const remoteBeam = {
  id: "beam-free",
  name: "Beam Free",
  provider: "opencode",
  api: "openai-completions",
  baseUrl: "https://opencode.ai/inference/v1",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_048_576,
  maxTokens: 131_072,
  compat: {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsStrictMode: true,
    maxTokensField: "max_tokens",
  },
  thinkingLevelMap: {
    off: null,
    low: "low",
    medium: "medium",
    high: "high",
    max: null,
  },
};

const remoteDeepSeek = {
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
  thinkingLevelMap: {
    off: null,
    low: "low",
    high: "high",
    max: "max",
  },
};

const remoteCatalog = [remoteBeam, remoteDeepSeek];

const storedModel: Model<"openai-completions"> = {
  id: "stored-free",
  name: "Stored Free",
  provider: "opencode-free",
  api: "openai-completions",
  baseUrl: "http://proxy.test/v1",
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 64_000,
  maxTokens: 8_000,
  reasoning: false,
};

describe("environment resolution", () => {
  it("uses the OpenCode endpoint and public token by default", () => {
    expect(resolveBaseUrl({})).toBe(DEFAULT_BASE_URL);
    expect(resolveApiKey({})).toBe("public");
  });

  it("trims a proxy base URL and removes trailing slashes", () => {
    expect(resolveBaseUrl({ OPENCODE_FREE_BASE_URL: "  http://localhost:8080/v1/// " })).toBe(
      "http://localhost:8080/v1",
    );
  });

  it("prefers the free key and falls back to the standard OpenCode key", () => {
    expect(resolveApiKey({ OPENCODE_FREE_API_KEY: " free ", OPENCODE_API_KEY: "paid" })).toBe(
      "free",
    );
    expect(resolveApiKey({ OPENCODE_API_KEY: " paid " })).toBe("paid");
  });
});

describe("initial free models", () => {
  it("seeds the catalog from Pi's built-in OpenCode models", () => {
    const models = initialFreeModels();
    const ids = models.map((model) => model.id);

    expect(ids.length).toBeGreaterThan(0);
    expect(ids).toContain("big-pickle");
    expect(ids).not.toContain("jev-1.13-free");

    for (const model of models) {
      expect(model.cost.input).toBe(0);
      expect(model.cost.output).toBe(0);
      expect(model.maxTokens).toBeGreaterThan(0);
      expect(model.contextWindow).toBeGreaterThan(0);
    }
  });

  it("returns a fresh array for each call", () => {
    expect(initialFreeModels()).not.toBe(initialFreeModels());
  });
});

describe("stored model conversion", () => {
  it("restores provider-owned chat models from Pi's model store", () => {
    const configs = configsFromStoredModels(
      [
        storedModel,
        { ...storedModel, id: "other-provider", provider: "opencode" },
        { ...storedModel, id: "other-api", api: "anthropic-messages" },
      ],
      "opencode-free",
    );

    expect(configs).toEqual([
      {
        id: "stored-free",
        name: "Stored Free",
        input: ["text"],
        cost: storedModel.cost,
        contextWindow: 64_000,
        maxTokens: 8_000,
        reasoning: false,
      },
    ]);
  });

  it("converts discovered models into persisted catalog entries", () => {
    const config: FreeChatModelConfig = {
      id: "stored-free",
      name: "Stored Free",
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 64_000,
      maxTokens: 8_000,
      reasoning: true,
      compat: { supportsStore: false },
    };

    expect(storedModelsFromConfigs([config], "opencode-free", "http://proxy.test/v1")).toEqual([
      {
        ...config,
        provider: "opencode-free",
        api: "openai-completions",
        baseUrl: "http://proxy.test/v1",
      },
    ]);
  });
});

describe("free model discovery", () => {
  it("intersects live models with Pi's native free chat catalog", async () => {
    const { fetcher, calls } = createFetcher((url) => {
      if (url === MODEL_CATALOG_URL) {
        return jsonResponse(
          JSON.stringify([
            ...remoteCatalog,
            {
              id: "big-pickle",
              name: "Big Pickle Native",
              provider: "opencode",
              api: "openai-completions",
              baseUrl: "https://opencode.ai/inference/v1",
              reasoning: true,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 300_000,
              maxTokens: 64_000,
            },
            {
              id: "paid-model",
              provider: "opencode",
              api: "openai-completions",
              input: ["text"],
              cost: { input: 1, output: 2 },
              contextWindow: 100_000,
              maxTokens: 10_000,
              reasoning: false,
            },
            {
              id: "jev-1.13-free",
              provider: "opencode",
              api: "typesafe-system-one",
              input: ["text"],
              cost: { input: 0, output: 0 },
              contextWindow: 32_000,
            },
            {
              id: "anthropic-only-free",
              provider: "opencode",
              api: "anthropic-messages",
              input: ["text"],
              cost: { input: 0, output: 0 },
              contextWindow: 100_000,
              maxTokens: 10_000,
              reasoning: false,
            },
          ]),
          200,
          { "last-modified": FUTURE_LAST_MODIFIED },
        );
      }

      return jsonResponse(
        JSON.stringify({
          data: [
            { id: "beam-free" },
            { id: "deepseek-v4.1-flash-free" },
            { id: "big-pickle" },
            { id: "paid-model" },
            { id: "jev-1.13-free" },
            { id: "anthropic-only-free" },
            { id: "test" },
          ],
        }),
      );
    });

    const models = requireModels(
      await discoverFreeModels({
        baseUrl: "http://proxy.test/v1",
        headers: { "x-test-header": "yes" },
        signal: new AbortController().signal,
        fetcher,
        allowNetwork: true,
      }),
    );

    expect(models.map((model) => model.id)).toEqual([
      "beam-free",
      "deepseek-v4.1-flash-free",
      "big-pickle",
    ]);

    const beam = models[0];
    expect(beam?.name).toBe("Beam Free");
    expect(beam?.input).toEqual(["text", "image"]);
    expect(beam?.contextWindow).toBe(1_048_576);
    expect(beam?.maxTokens).toBe(131_072);
    expect(beam?.thinkingLevelMap).toMatchObject({
      off: null,
      low: "low",
      medium: "medium",
      high: "high",
      max: null,
    });

    const deepSeek = models[1];
    expect(deepSeek?.compat).toMatchObject({ requiresReasoningContentOnAssistantMessages: true });

    const bigPickle = models[2];
    expect(bigPickle?.name).toBe("Big Pickle Native");
    expect(bigPickle?.contextWindow).toBe(300_000);

    const liveCall = calls.find((call) => call.url === "http://proxy.test/v1/models");
    expect(liveCall?.headers.get("accept")).toBe("application/json");
    expect(liveCall?.headers.get("x-test-header")).toBe("yes");

    const catalogCall = calls.find((call) => call.url === MODEL_CATALOG_URL);
    expect(catalogCall?.headers.get("accept")).toBe("application/json");
  });

  it("uses bundled native metadata when pi.dev has no newer catalog", async () => {
    const { fetcher } = createFetcher((url) =>
      url === MODEL_CATALOG_URL
        ? jsonResponse(JSON.stringify(remoteCatalog), 200, {
            "last-modified": "Thu, 01 Jan 1970 00:00:00 GMT",
          })
        : jsonResponse(JSON.stringify({ data: [{ id: "big-pickle" }, { id: "beam-free" }] })),
    );

    const models = requireModels(
      await discoverFreeModels({
        baseUrl: DEFAULT_BASE_URL,
        headers: {},
        signal: new AbortController().signal,
        fetcher,
        allowNetwork: true,
      }),
    );

    expect(models.map((model) => model.id)).toEqual(["big-pickle"]);
    expect(models[0]?.name).not.toBe("Big Pickle Native");
  });

  it("returns undefined when the native catalog is unavailable", async () => {
    const { fetcher } = createFetcher((url) => {
      if (url === MODEL_CATALOG_URL) return jsonResponse("unavailable", 503);

      return jsonResponse(
        JSON.stringify({
          data: [{ id: "beam-free" }, { id: "big-pickle" }, { id: "paid-model" }],
        }),
      );
    });

    const models = await discoverFreeModels({
      baseUrl: DEFAULT_BASE_URL,
      headers: {},
      signal: new AbortController().signal,
      fetcher,
      allowNetwork: true,
    });

    expect(models).toBeUndefined();
  });

  it("returns undefined when the live endpoint fails", async () => {
    const { fetcher } = createFetcher((url) =>
      url === MODEL_CATALOG_URL
        ? jsonResponse(JSON.stringify(remoteCatalog), 200, {
            "last-modified": FUTURE_LAST_MODIFIED,
          })
        : jsonResponse("nope", 500),
    );

    const models = await discoverFreeModels({
      baseUrl: DEFAULT_BASE_URL,
      headers: {},
      signal: new AbortController().signal,
      fetcher,
      allowNetwork: true,
    });

    expect(models).toBeUndefined();
  });

  it("returns undefined on malformed live JSON", async () => {
    const { fetcher } = createFetcher((url) =>
      url === MODEL_CATALOG_URL
        ? jsonResponse(JSON.stringify(remoteCatalog), 200, {
            "last-modified": FUTURE_LAST_MODIFIED,
          })
        : jsonResponse("{"),
    );

    const models = await discoverFreeModels({
      baseUrl: DEFAULT_BASE_URL,
      headers: {},
      signal: new AbortController().signal,
      fetcher,
      allowNetwork: true,
    });

    expect(models).toBeUndefined();
  });

  it("returns undefined on an empty live list", async () => {
    const { fetcher } = createFetcher((url) =>
      url === MODEL_CATALOG_URL
        ? jsonResponse(JSON.stringify(remoteCatalog), 200, {
            "last-modified": FUTURE_LAST_MODIFIED,
          })
        : jsonResponse(JSON.stringify({ data: [] })),
    );

    const models = await discoverFreeModels({
      baseUrl: DEFAULT_BASE_URL,
      headers: {},
      signal: new AbortController().signal,
      fetcher,
      allowNetwork: true,
    });

    expect(models).toBeUndefined();
  });

  it("returns undefined when no live model is known to be free", async () => {
    const { fetcher } = createFetcher((url) =>
      url === MODEL_CATALOG_URL
        ? jsonResponse(
            JSON.stringify([
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
            ]),
            200,
            { "last-modified": FUTURE_LAST_MODIFIED },
          )
        : jsonResponse(JSON.stringify({ data: [{ id: "paid-model" }, { id: "unknown" }] })),
    );

    const models = await discoverFreeModels({
      baseUrl: DEFAULT_BASE_URL,
      headers: {},
      signal: new AbortController().signal,
      fetcher,
      allowNetwork: true,
    });

    expect(models).toBeUndefined();
  });

  it("returns undefined on a malformed native catalog", async () => {
    const { fetcher } = createFetcher((url) =>
      url === MODEL_CATALOG_URL
        ? jsonResponse(JSON.stringify({ opencode: null }))
        : jsonResponse(JSON.stringify({ data: [{ id: "beam-free" }] })),
    );

    const models = await discoverFreeModels({
      baseUrl: DEFAULT_BASE_URL,
      headers: {},
      signal: new AbortController().signal,
      fetcher,
      allowNetwork: true,
    });

    expect(models).toBeUndefined();
  });

  it.each([
    { contextWindow: 0.5 },
    { maxTokens: 0.5 },
    { cost: { input: 0, output: 0, cacheRead: -1 } },
    { cost: { input: 0, output: 0, cacheWrite: "invalid" } },
  ])("rejects invalid limits or cache pricing: %j", async (invalid) => {
    const { fetcher } = createFetcher((url) =>
      url === MODEL_CATALOG_URL
        ? jsonResponse(
            JSON.stringify([{ ...remoteBeam, id: "invalid-test-free", ...invalid }]),
            200,
            {
              "last-modified": FUTURE_LAST_MODIFIED,
            },
          )
        : jsonResponse(JSON.stringify({ data: [{ id: "invalid-test-free" }] })),
    );

    expect(
      await discoverFreeModels({
        baseUrl: DEFAULT_BASE_URL,
        headers: {},
        signal: new AbortController().signal,
        fetcher,
        allowNetwork: true,
      }),
    ).toBeUndefined();
  });

  it("skips a malformed catalog entry without discarding its valid siblings", async () => {
    const { fetcher } = createFetcher((url) =>
      url === MODEL_CATALOG_URL
        ? jsonResponse(
            JSON.stringify([
              { ...remoteBeam, name: 42 },
              {
                ...remoteBeam,
                id: "second-free",
                name: "Second Free",
              },
            ]),
            200,
            { "last-modified": FUTURE_LAST_MODIFIED },
          )
        : jsonResponse(JSON.stringify({ data: [{ id: "beam-free" }, { id: "second-free" }] })),
    );

    const models = requireModels(
      await discoverFreeModels({
        baseUrl: DEFAULT_BASE_URL,
        headers: {},
        signal: new AbortController().signal,
        fetcher,
        allowNetwork: true,
      }),
    );

    expect(models.map((model) => model.id)).toEqual(["second-free"]);
    expect(models[0]?.name).toBe("Second Free");
  });

  describe("discovery status", () => {
    const options = (fetcher: typeof fetch, signal = new AbortController().signal) => ({
      baseUrl: DEFAULT_BASE_URL,
      headers: {},
      signal,
      fetcher,
      allowNetwork: true,
    });

    const catalogResponse = (value: typeof remoteCatalog) =>
      jsonResponse(JSON.stringify(value), 200, { "last-modified": FUTURE_LAST_MODIFIED });

    it("reports offline and aborted attempts without touching the network", async () => {
      const { fetcher, calls } = createFetcher(() => {
        throw new Error("fetch should not run");
      });

      const controller = new AbortController();
      controller.abort();

      expect(
        await discoverFreeModelsWithStatus({ ...options(fetcher), allowNetwork: false }),
      ).toEqual({ status: "offline" });
      expect(await discoverFreeModelsWithStatus(options(fetcher, controller.signal))).toEqual({
        status: "aborted",
      });
      expect(calls).toHaveLength(0);
    });

    it.each([
      [
        "live-request-failed",
        () => jsonResponse("unavailable", 503),
        () => catalogResponse(remoteCatalog),
      ],
      [
        "live-response-invalid",
        () => jsonResponse(JSON.stringify({ data: "nope" })),
        () => catalogResponse(remoteCatalog),
      ],
      [
        "catalog-request-failed",
        () => jsonResponse(JSON.stringify({ data: [{ id: "beam-free" }] })),
        () => jsonResponse("unavailable", 503),
      ],
      [
        "catalog-response-invalid",
        () => jsonResponse(JSON.stringify({ data: [{ id: "beam-free" }] })),
        () => jsonResponse(JSON.stringify({ opencode: null })),
      ],
    ])("classifies %s", async (status, live, catalog) => {
      const { fetcher } = createFetcher((url) => (url === MODEL_CATALOG_URL ? catalog() : live()));

      expect(await discoverFreeModelsWithStatus(options(fetcher))).toEqual({ status });
    });

    it("classifies an empty live catalog and an unknown free intersection", async () => {
      const empty = createFetcher((url) =>
        url === MODEL_CATALOG_URL
          ? catalogResponse(remoteCatalog)
          : jsonResponse(JSON.stringify({ data: [] })),
      );

      const unknown = createFetcher((url) =>
        url === MODEL_CATALOG_URL
          ? catalogResponse(remoteCatalog)
          : jsonResponse(JSON.stringify({ data: [{ id: "unknown" }] })),
      );

      expect(await discoverFreeModelsWithStatus(options(empty.fetcher))).toEqual({
        status: "live-empty",
        liveModelCount: 0,
      });
      expect(await discoverFreeModelsWithStatus(options(unknown.fetcher))).toEqual({
        status: "no-known-free-models",
        liveModelCount: 1,
      });
    });

    it.each(["abort", "timeout"])("classifies %s during discovery", async (kind) => {
      const controller = new AbortController();

      const fetcher: typeof fetch = async () => {
        controller.abort(
          new DOMException(
            "private failure details",
            kind === "timeout" ? "TimeoutError" : "AbortError",
          ),
        );
        throw controller.signal.reason;
      };

      expect(await discoverFreeModelsWithStatus(options(fetcher, controller.signal))).toEqual({
        status: kind === "timeout" ? "timeout" : "aborted",
      });
    });

    it.each([
      ["live-response-invalid", "live"],
      ["catalog-response-invalid", "catalog"],
    ])("classifies malformed JSON as %s", async (status, endpoint) => {
      const { fetcher } = createFetcher((url) => {
        if (url === MODEL_CATALOG_URL)
          return endpoint === "catalog" ? jsonResponse("{") : catalogResponse(remoteCatalog);

        return endpoint === "live"
          ? jsonResponse("{")
          : jsonResponse(JSON.stringify({ data: [{ id: "beam-free" }] }));
      });

      expect(await discoverFreeModelsWithStatus(options(fetcher))).toEqual({ status });
    });

    it("reports the live catalog size on success", async () => {
      const { fetcher } = createFetcher((url) =>
        url === MODEL_CATALOG_URL
          ? catalogResponse(remoteCatalog)
          : jsonResponse(
              JSON.stringify({ data: [{ id: "beam-free" }, { id: "deepseek-v4.1-flash-free" }] }),
            ),
      );

      const outcome = await discoverFreeModelsWithStatus(options(fetcher));

      expect(outcome.status).toBe("ok");
      expect(outcome.liveModelCount).toBe(2);
      expect(outcome.models?.map((model) => model.id)).toEqual([
        "beam-free",
        "deepseek-v4.1-flash-free",
      ]);
    });
  });

  it("does not touch the network when disabled or already aborted", async () => {
    const { fetcher, calls } = createFetcher(() => {
      throw new Error("fetch should not run");
    });

    const controller = new AbortController();
    controller.abort();

    const offline = await discoverFreeModels({
      baseUrl: DEFAULT_BASE_URL,
      headers: {},
      signal: new AbortController().signal,
      fetcher,
      allowNetwork: false,
    });

    const aborted = await discoverFreeModels({
      baseUrl: DEFAULT_BASE_URL,
      headers: {},
      signal: controller.signal,
      fetcher,
      allowNetwork: true,
    });

    expect(offline).toBeUndefined();
    expect(aborted).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});
