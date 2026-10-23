import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_BASE_URL,
  MODELS_DEV_URL,
  configsFromStoredModels,
  discoverFreeModels,
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

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
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

const freeBeam = {
  id: "beam-free",
  name: "Beam Free",
  reasoning: true,
  reasoning_options: [{ type: "effort", values: ["low", "high"] }],
  tool_call: true,
  modalities: { input: ["text", "image"], output: ["text"] },
  limit: { context: 400_000, output: 50_000 },
  cost: { input: 0, output: 0 },
};

const freeDeepSeek = {
  id: "deepseek-v4.1-flash-free",
  name: "DeepSeek V4.1 Flash Free",
  reasoning: true,
  reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
  tool_call: true,
  interleaved: { field: "reasoning_content" },
  modalities: { input: ["text", "image"], output: ["text"] },
  limit: { context: 200_000, output: 32_000 },
  cost: { input: 0, output: 0 },
};

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
  it("intersects live models with free chat metadata", async () => {
    const { fetcher, calls } = createFetcher((url) => {
      if (url === MODELS_DEV_URL) {
        return jsonResponse(
          JSON.stringify({
            opencode: {
              models: {
                "beam-free": freeBeam,
                "deepseek-v4.1-flash-free": freeDeepSeek,
                "paid-model": {
                  id: "paid-model",
                  cost: { input: 1, output: 2 },
                  tool_call: true,
                },
                "jev-1.13-free": {
                  id: "jev-1.13-free",
                  cost: { input: 0, output: 0 },
                  tool_call: false,
                },
                "anthropic-only-free": {
                  id: "anthropic-only-free",
                  cost: { input: 0, output: 0 },
                  tool_call: true,
                  provider: { api: "https://opencode.ai/inference/anthropic/v1" },
                },
              },
            },
          }),
        );
      }

      return jsonResponse(
        JSON.stringify({
          data: [
            { id: "beam-free" },
            { id: "deepseek-v4.1-flash-free" },
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

    expect(models.map((model) => model.id)).toEqual(["beam-free", "deepseek-v4.1-flash-free"]);

    const beam = models[0];
    expect(beam?.name).toBe("Beam Free");
    expect(beam?.input).toEqual(["text", "image"]);
    expect(beam?.contextWindow).toBe(400_000);
    expect(beam?.maxTokens).toBe(50_000);
    expect(beam?.thinkingLevelMap).toMatchObject({
      off: null,
      low: "low",
      medium: null,
      high: "high",
      max: null,
    });

    const deepSeek = models[1];
    expect(deepSeek?.compat).toMatchObject({ requiresReasoningContentOnAssistantMessages: true });

    const liveCall = calls.find((call) => call.url === "http://proxy.test/v1/models");
    expect(liveCall?.headers.get("accept")).toBe("application/json");
    expect(liveCall?.headers.get("x-test-header")).toBe("yes");
  });

  it("returns undefined when the metadata catalog is unavailable", async () => {
    const { fetcher } = createFetcher((url) => {
      if (url === MODELS_DEV_URL) return jsonResponse("unavailable", 503);

      return jsonResponse(
        JSON.stringify({
          data: [
            { id: "beam-free" },
            { id: "jev-1.13-free" },
            { id: "big-pickle" },
            { id: "paid-model" },
          ],
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
    const { fetcher } = createFetcher(() => jsonResponse("nope", 500));

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
      url === MODELS_DEV_URL
        ? jsonResponse(JSON.stringify({ opencode: { models: {} } }))
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
      url === MODELS_DEV_URL
        ? jsonResponse(JSON.stringify({ opencode: { models: {} } }))
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
      url === MODELS_DEV_URL
        ? jsonResponse(
            JSON.stringify({
              opencode: {
                models: {
                  "paid-model": { id: "paid-model", cost: { input: 1, output: 1 } },
                },
              },
            }),
          )
        : jsonResponse(JSON.stringify({ data: [{ id: "paid-model" }] })),
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

  it("returns undefined on a malformed metadata catalog", async () => {
    const { fetcher } = createFetcher((url) =>
      url === MODELS_DEV_URL
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
