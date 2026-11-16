import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type JsonObject,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  catalogFromAvailableModels,
  modelsFromStored,
  recommendedRuntimeIds,
  resolveCatalog,
  storedModelsFrom,
} from "../src/discovery";
import { FALLBACK_MODELS, modelConfigs } from "../src/models";
import { getApiKey } from "../src/oauth";

/** Metadata shaped like the backend's `fetchAvailableModels` response. */
function metadata(displayName: string, extra: JsonObject = {}): JsonObject {
  return { displayName, ...extra };
}

function availableModels(): JsonObject {
  return {
    models: {
      "gemini-3.8-flash-low": metadata("Gemini 3.8 Flash (Low)", {
        maxTokens: 1_048_576,
        maxOutputTokens: 65_536,
        supportsThinking: true,
        supportsImages: true,
      }),
      "gemini-3.8-flash-medium": metadata("Gemini 3.8 Flash (Medium)", {
        maxTokens: 1_048_576,
        maxOutputTokens: 65_536,
        supportsThinking: true,
        supportsImages: true,
      }),
      "gemini-3.8-flash-high": metadata("Gemini 3.8 Flash (High)", {
        maxTokens: 1_048_576,
        maxOutputTokens: 65_536,
        supportsThinking: true,
        supportsImages: true,
      }),
      "claude-sonnet-4-6": metadata("Claude Sonnet 4.6 (Thinking)", {
        maxTokens: 200_000,
        maxOutputTokens: 64_000,
        supportsThinking: true,
        supportsImages: true,
      }),
      "claude-opus-4-6-thinking": metadata("Claude Opus 4.6 (Thinking)", {
        maxTokens: 250_000,
        maxOutputTokens: 64_000,
        supportsThinking: true,
        supportsImages: true,
      }),
      "gpt-oss-120b-medium": metadata("GPT-OSS 120B (Medium)", {
        maxTokens: 131_072,
        maxOutputTokens: 32_768,
        supportsThinking: true,
        supportsImages: false,
      }),
    },
  };
}

const API_KEY = getApiKey({
  access: "access-token",
  refresh: "refresh-token",
  expires: 0,
  projectId: "project-under-test",
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("catalog grouping", () => {
  it("collapses the runtime variants the CLI lists into public models", () => {
    const catalog = catalogFromAvailableModels(availableModels());

    expect(catalog?.map((model) => model.id)).toEqual([
      "gemini-3.8-flash",
      "claude-sonnet-4-6",
      "claude-opus-4-6",
      "gpt-oss-120b",
    ]);
  });

  it("maps each thinking level to the runtime id the backend serves", () => {
    const gemini = catalogFromAvailableModels(availableModels())?.find(
      (model) => model.id === "gemini-3.8-flash",
    );

    expect(gemini?.thinkingLevelMap).toEqual({
      off: null,
      minimal: null,
      low: "gemini-3.8-flash-low",
      medium: "gemini-3.8-flash-medium",
      high: "gemini-3.8-flash-high",
      xhigh: null,
      max: null,
    });
  });

  it("lets Pi clamp fixed-effort models to their advertised level", () => {
    const catalog = catalogFromAvailableModels(availableModels());
    const stored = storedModelsFrom(modelConfigs(catalog), "antigravity", "https://example.test");
    const opus = stored.find((model) => model.id === "claude-opus-4-6");
    const gpt = stored.find((model) => model.id === "gpt-oss-120b");

    expect(opus).toBeDefined();
    expect(gpt).toBeDefined();

    if (opus === undefined || gpt === undefined) return;
    expect(getSupportedThinkingLevels(opus)).toEqual(["high"]);
    expect(clampThinkingLevel(opus, "medium")).toBe("high");
    expect(getSupportedThinkingLevels(gpt)).toEqual(["medium"]);
  });

  it("takes the name from the display name without its level", () => {
    const names = catalogFromAvailableModels(availableModels())?.map((model) => model.name);

    expect(names).toEqual([
      "Gemini 3.8 Flash",
      "Claude Sonnet 4.6",
      "Claude Opus 4.6",
      "GPT-OSS 120B",
    ]);
  });

  it("uses the limits the backend advertises", () => {
    const catalog = catalogFromAvailableModels(availableModels());
    const gemini = catalog?.find((model) => model.id === "gemini-3.8-flash");
    const gptOss = catalog?.find((model) => model.id === "gpt-oss-120b");

    expect(gemini?.contextWindow).toBe(1_048_576);
    expect(gemini?.maxTokens).toBe(65_536);
    expect(gptOss?.contextWindow).toBe(131_072);
    expect(gptOss?.input).toEqual(["text"]);
  });

  it("advertises the smallest limit when variants disagree", () => {
    const catalog = catalogFromAvailableModels({
      models: {
        "gemini-3.8-flash-low": metadata("Gemini 3.8 Flash (Low)", { maxTokens: 100_000 }),
        "gemini-3.8-flash-high": metadata("Gemini 3.8 Flash (High)", { maxTokens: 200_000 }),
      },
    });

    expect(catalog?.[0]?.contextWindow).toBe(100_000);
  });

  it("keeps the catalog order stable across levels", () => {
    const catalog = catalogFromAvailableModels({
      models: {
        "gemini-3.8-flash-high": metadata("Gemini 3.8 Flash (High)"),
        "gemini-3.8-flash-low": metadata("Gemini 3.8 Flash (Low)"),
      },
    });

    expect(catalog).toHaveLength(1);
    expect(catalog?.[0]?.id).toBe("gemini-3.8-flash");
  });

  it("routes an unlabelled variant from every level", () => {
    const catalog = catalogFromAvailableModels({
      models: { "gemini-2.5-flash": metadata("Gemini 2.5 Flash") },
    });

    expect(catalog?.[0]?.thinkingLevelMap.high).toBe("gemini-2.5-flash");
    expect(catalog?.[0]?.reasoning).toBe(true);
  });

  it("drops models the account cannot select", () => {
    const catalog = catalogFromAvailableModels({
      models: {
        "gemini-3.8-flash-low": metadata("Gemini 3.8 Flash (Low)"),
        chat_20706: metadata("Chat helper"),
        tab_5d84: metadata("Completion"),
        "imagen-4": metadata("Imagen 4"),
        "gemini-3.8-flash-high-disabled": metadata("Disabled"),
        MODEL_PLACEHOLDER: metadata("Placeholder"),
        "internal-1": metadata("Internal", { isInternal: true }),
        "internal-2": metadata("Internal 2", { apiProvider: "API_PROVIDER_INTERNAL" }),
        "broken id": metadata("Broken"),
      },
    });

    expect(catalog?.map((model) => model.id)).toEqual(["gemini-3.8-flash"]);
  });

  it("honours the backend's recommended list", () => {
    const catalog = catalogFromAvailableModels({
      ...availableModels(),
      agentModelSorts: [
        {
          groups: [
            { modelIds: ["gemini-3.8-flash-high", "gemini-3.8-flash-low"] },
            { modelIds: ["claude-sonnet-4-6"] },
          ],
        },
      ],
    });

    expect(catalog?.map((model) => model.id)).toEqual(["gemini-3.8-flash", "claude-sonnet-4-6"]);
  });

  it("does not expose unrecommended models when recommendations match nothing usable", () => {
    const catalog = catalogFromAvailableModels({
      ...availableModels(),
      agentModelSorts: [{ groups: [{ modelIds: ["retired-model"] }] }],
    });

    expect(catalog).toBeUndefined();
  });

  it("does not add unrecommended hydrogen variants", () => {
    const catalog = catalogFromAvailableModels({
      models: {
        "gemini-3.8-flash-low": metadata("Gemini 3.8 Flash (Low)"),
        "gemini-4-hydrogen-high": metadata("Gemini 4 Hydrogen (High)"),
      },
      agentModelSorts: [{ groups: [{ modelIds: ["gemini-3.8-flash-low"] }] }],
    });

    expect(catalog?.map((model) => model.id)).toEqual(["gemini-3.8-flash"]);
  });

  it("reads recommended ids defensively", () => {
    expect(recommendedRuntimeIds(undefined)).toBeUndefined();
    expect(recommendedRuntimeIds([])).toBeUndefined();
    expect(recommendedRuntimeIds([{ groups: "nope" }])).toBeUndefined();
    expect(recommendedRuntimeIds([{ groups: [{ modelIds: [1, "a"] }] }])).toEqual(new Set(["a"]));
  });

  it("returns undefined for payloads without models", () => {
    expect(catalogFromAvailableModels(undefined)).toBeUndefined();
    expect(catalogFromAvailableModels(null)).toBeUndefined();
    expect(catalogFromAvailableModels({ models: {} })).toBeUndefined();
    expect(catalogFromAvailableModels({ models: "nope" })).toBeUndefined();
  });

  it("falls back to the seed catalog for unknown models without metadata", () => {
    const catalog = catalogFromAvailableModels({
      models: { "claude-opus-4-9": metadata("Claude Opus 4.9 (Thinking)") },
    });

    expect(catalog?.[0]?.contextWindow).toBe(128_000);
    expect(catalog?.[0]?.maxTokens).toBe(32_768);
    expect(catalog?.[0]?.input).toEqual(["text", "image"]);
  });
});

describe("catalog refresh", () => {
  it("fetches the catalog with the project the account is billed against", async () => {
    const seen: { url: string; body: string; authorization: string | null }[] = [];

    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);

      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the extension always sends a string body
      const body = typeof init.body === "string" ? init.body : "";

      seen.push({ url, body, authorization: headers.get("authorization") });

      return Response.json(availableModels());
    });

    const catalog = await resolveCatalog({
      apiKey: { token: "access-token", projectId: "project-under-test" },
      stored: undefined,
      providerId: "antigravity",
      allowNetwork: true,
      signal: undefined,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(
      "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
    );
    expect(JSON.parse(seen[0]?.body ?? "{}")).toEqual({ project: "project-under-test" });
    expect(seen[0]?.authorization).toBe("Bearer access-token");
    expect(catalog).toHaveLength(4);
  });

  it("keeps the seed catalog when offline", async () => {
    const fetchSpy = vi.fn();

    vi.stubGlobal("fetch", fetchSpy);

    const catalog = await resolveCatalog({
      apiKey: { token: "access-token", projectId: "project-under-test" },
      stored: undefined,
      providerId: "antigravity",
      allowNetwork: false,
      signal: undefined,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(catalog.map((model) => model.id)).toEqual(FALLBACK_MODELS.map((model) => model.id));
  });

  it("keeps the seed catalog when the account is not signed in", async () => {
    const fetchSpy = vi.fn();

    vi.stubGlobal("fetch", fetchSpy);

    const catalog = await resolveCatalog({
      apiKey: undefined,
      stored: undefined,
      providerId: "antigravity",
      allowNetwork: true,
      signal: undefined,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(catalog).toHaveLength(4);
  });

  it("falls through the endpoints until one answers", async () => {
    const urls: string[] = [];

    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);

      return url.includes("daily-cloudcode-pa")
        ? new Response("quota", { status: 429 })
        : Response.json(availableModels());
    });

    const catalog = await resolveCatalog({
      apiKey: { token: "access-token", projectId: "project-under-test" },
      stored: undefined,
      providerId: "antigravity",
      allowNetwork: true,
      signal: undefined,
    });

    expect(urls.at(-1)).toContain("cloudcode-pa.googleapis.com");
    expect(catalog).toHaveLength(4);
  });

  it("prefers the stored catalog over the seed when discovery fails", async () => {
    vi.stubGlobal("fetch", async () => new Response("denied", { status: 403 }));

    const stored = storedModelsFrom(
      modelConfigs([FALLBACK_MODELS[1]!]),
      "antigravity",
      "https://daily-cloudcode-pa.googleapis.com",
    );

    const catalog = await resolveCatalog({
      apiKey: { token: "access-token", projectId: "project-under-test" },
      stored,
      providerId: "antigravity",
      allowNetwork: true,
      signal: undefined,
    });

    expect(catalog.map((model) => model.id)).toEqual(["claude-sonnet-4-6"]);
  });

  it("round-trips a catalog through Pi's stored model shape", () => {
    const configs = modelConfigs();
    const stored = storedModelsFrom(configs, "antigravity", "https://example.test");
    const restored = modelsFromStored(stored, "antigravity");

    expect(restored?.map((model) => model.id)).toEqual(configs.map((config) => config.id));
    expect(restored?.[0]?.thinkingLevelMap).toEqual(configs[0]?.thinkingLevelMap);
    expect(stored[0]?.baseUrl).toBe("https://example.test");
    expect(stored[0]?.provider).toBe("antigravity");
  });

  it("ignores stored models owned by another provider or API", () => {
    const foreign = [
      ...storedModelsFrom(modelConfigs(), "other-provider", "https://example.test"),
      {
        ...storedModelsFrom(modelConfigs(), "antigravity", "https://example.test")[0],
        api: "openai-completions",
      },
    ];

    expect(modelsFromStored(foreign, "antigravity")).toBeUndefined();
  });

  it("never throws when the credential cannot be decoded", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });

    const catalog = await resolveCatalog({
      apiKey: { token: "access-token", projectId: "project-under-test" },
      stored: undefined,
      providerId: "antigravity",
      allowNetwork: true,
      signal: undefined,
    });

    expect(catalog).toHaveLength(4);
    expect(API_KEY).toContain("access-token");
  });
});
