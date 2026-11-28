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
import { FALLBACK_MODELS, modelConfigs, resolveRuntimeModel } from "../src/models";
import { getApiKey } from "../src/oauth";

/** Metadata shaped like the backend's `fetchAvailableModels` response. */
function metadata(displayName: string, extra: JsonObject = {}): JsonObject {
  return { displayName, ...extra };
}

function availableModels() {
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
      "gemini-claude-sonnet-4-6": metadata("Claude Sonnet 4.6 (Thinking)", {
        maxTokens: 200_000,
        maxOutputTokens: 64_000,
        supportsThinking: true,
        supportsImages: true,
      }),
      "gemini-claude-opus-4-6-thinking": metadata("Claude Opus 4.6 (Thinking)", {
        maxTokens: 250_000,
        maxOutputTokens: 64_000,
        supportsThinking: true,
        supportsImages: true,
      }),
      "gemini-gpt-oss-120b-medium": metadata("GPT-OSS 120B (Medium)", {
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
  it("uses advertised numeric thinking levels and preserves image restrictions", () => {
    const catalog = catalogFromAvailableModels({
      models: {
        "gemini-example-low": metadata("Example", {
          thinkingLevel: 1,
          supportsThinking: true,
          supportsImages: false,
        }),
        "gemini-example-high": metadata("Example", {
          thinkingLevel: 3,
          supportsThinking: true,
          supportsImages: true,
        }),
      },
    });

    expect(catalog?.[0]?.thinkingLevelMap).toMatchObject({
      low: "gemini-example-low",
      high: "gemini-example-high",
      medium: null,
    });
    expect(catalog?.[0]?.input).not.toContain("image");
  });

  it("uses an advertised route when standard levels are unavailable", () => {
    expect(
      resolveRuntimeModel({ id: "example", thinkingLevelMap: { minimal: "example-minimal" } }),
    ).toBe("example-minimal");
    expect(
      resolveRuntimeModel({ id: "example", thinkingLevelMap: { xhigh: "example-xhigh" } }, "low"),
    ).toBe("example-xhigh");
  });

  it("collapses runtime variants into public models with only their advertised routes", () => {
    const catalog = catalogFromAvailableModels(availableModels());
    const stored = storedModelsFrom(modelConfigs(catalog), "antigravity", "https://example.test");

    const expected = {
      "gemini-3.8-flash": {
        low: "gemini-3.8-flash-low",
        medium: "gemini-3.8-flash-medium",
        high: "gemini-3.8-flash-high",
      },
      "gemini-claude-sonnet-4-6": { high: "gemini-claude-sonnet-4-6" },
      "gemini-claude-opus-4-6": { high: "gemini-claude-opus-4-6-thinking" },
      "gemini-gpt-oss-120b": { medium: "gemini-gpt-oss-120b-medium" },
    } as const;

    expect(stored.map((model) => model.id)).toEqual(Object.keys(expected));
    expect(catalog?.map((model) => model.name)).toEqual([
      "Gemini 3.8 Flash",
      "Claude Sonnet 4.6",
      "Claude Opus 4.6",
      "GPT-OSS 120B",
    ]);

    for (const [id, routes] of Object.entries(expected)) {
      const model = stored.find((entry) => entry.id === id);
      expect(model).toBeDefined();

      if (model === undefined) continue;
      expect(getSupportedThinkingLevels(model)).toEqual(Object.keys(routes));

      for (const level of getSupportedThinkingLevels(model)) {
        const route = Object.entries(routes).find(([key]) => key === level);
        expect(resolveRuntimeModel(model, level)).toBe(route?.[1]);
      }

      if (id === "gemini-claude-opus-4-6") {
        expect(clampThinkingLevel(model, "medium")).toBe("high");
      }
    }
  });

  it("discovers budget controls only for a single runtime advertising a positive budget", () => {
    const catalog = catalogFromAvailableModels({
      models: {
        "gemini-budget-only": metadata("Budget (Thinking)", {
          supportsThinking: true,
          thinkingBudget: 1024,
        }),
        "gemini-named-low": metadata("Named (Low)", {
          supportsThinking: true,
          thinkingLevel: 1,
          thinkingBudget: 1024,
        }),
        "gemini-other-low": metadata("Other (Low)", {
          supportsThinking: true,
          thinkingBudget: 1024,
        }),
        "gemini-other-high": metadata("Other (High)", {
          supportsThinking: true,
          thinkingBudget: 2048,
        }),
        "gemini-invalid-medium": metadata("Invalid (Medium)", {
          supportsThinking: true,
          thinkingBudget: -1,
        }),
      },
    });

    expect(
      catalog?.find((model) => model.id === "gemini-budget-only")?.thinkingLevelMap,
    ).toMatchObject({
      minimal: "gemini-budget-only",
      low: "gemini-budget-only",
      medium: "gemini-budget-only",
      high: "gemini-budget-only",
      xhigh: null,
      max: null,
    });
    expect(
      catalog?.find((model) => model.id === "gemini-named")?.thinkingLevelMap.medium,
    ).toBeNull();
    expect(
      catalog?.find((model) => model.id === "gemini-other")?.thinkingLevelMap.medium,
    ).toBeNull();
    expect(
      catalog?.find((model) => model.id === "gemini-invalid")?.thinkingLevelMap.low,
    ).toBeNull();
  });

  it("uses the limits the backend advertises", () => {
    const catalog = catalogFromAvailableModels(availableModels());
    const gemini = catalog?.find((model) => model.id === "gemini-3.8-flash");
    const gptOss = catalog?.find((model) => model.id === "gemini-gpt-oss-120b");

    expect(gemini?.contextWindow).toBe(1_048_576);
    expect(gemini?.maxTokens).toBe(65_536);
    expect(gptOss?.contextWindow).toBe(131_072);
    expect(gptOss?.input).toEqual(["text"]);
  });

  it("uses matching Pi Google metadata to constrain Gemini routes and limits", () => {
    const catalog = catalogFromAvailableModels({
      models: {
        "gemini-3.8-flash-minimal": metadata("Gemini 3.8 Flash (Minimal)", {
          maxTokens: 2_000_000,
          maxOutputTokens: 100_000,
        }),
        "gemini-3.8-flash-low": metadata("Gemini 3.8 Flash (Low)", {
          maxTokens: 2_000_000,
          maxOutputTokens: 100_000,
        }),
        "gemini-3.8-flash-high": metadata("Gemini 3.8 Flash (High)", {
          maxTokens: 2_000_000,
          maxOutputTokens: 100_000,
        }),
        "gemini-unknown-minimal": metadata("Gemini Unknown (Minimal)"),
      },
    });

    const gemini = catalog?.find((model) => model.id === "gemini-3.8-flash");
    expect(gemini?.thinkingLevelMap).toMatchObject({
      minimal: null,
      low: "gemini-3.8-flash-low",
      medium: null,
      high: "gemini-3.8-flash-high",
    });
    expect(gemini?.contextWindow).toBe(1_048_576);
    expect(gemini?.maxTokens).toBe(65_536);
    expect(catalog?.find((model) => model.id === "gemini-unknown")?.thinkingLevelMap.minimal).toBe(
      "gemini-unknown-minimal",
    );
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
      models: {
        ...availableModels().models,
        "gemini-4-hydrogen-high": metadata("Gemini 4 Hydrogen (High)"),
      },
      agentModelSorts: [
        {
          groups: [
            { modelIds: ["gemini-3.8-flash-high", "gemini-3.8-flash-low"] },
            { modelIds: ["gemini-claude-sonnet-4-6"] },
          ],
        },
      ],
    });

    expect(catalog?.map((model) => model.id)).toEqual([
      "gemini-3.8-flash",
      "gemini-claude-sonnet-4-6",
    ]);
  });

  it("does not expose unrecommended models when recommendations match nothing usable", () => {
    const catalog = catalogFromAvailableModels({
      ...availableModels(),
      agentModelSorts: [{ groups: [{ modelIds: ["retired-model"] }] }],
    });

    expect(catalog).toBeUndefined();
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
      models: { "gemini-claude-opus-4-9": metadata("Claude Opus 4.9 (Thinking)") },
    });

    expect(catalog?.[0]?.contextWindow).toBe(128_000);
    expect(catalog?.[0]?.maxTokens).toBe(32_768);
    expect(catalog?.[0]?.input).toEqual(["text", "image"]);
  });
});

describe("catalog refresh", () => {
  it("fetches the catalog with the project the account is billed against", async () => {
    const seen: {
      url: string;
      body: string;
      authorization: string | null;
      redirect: RequestRedirect | undefined;
    }[] = [];

    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);

      const body = typeof init.body === "string" ? init.body : "";

      seen.push({
        url,
        body,
        authorization: headers.get("authorization"),
        redirect: init.redirect,
      });

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
    expect(seen[0]?.redirect).toBe("error");
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

  it("does not discover or publish models when the account is not signed in", async () => {
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
    expect(catalog).toHaveLength(0);
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
      modelConfigs(catalogFromAvailableModels(availableModels()) ?? []),
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

    expect(catalog.map((model) => model.id)).toEqual([
      "gemini-3.8-flash",
      "gemini-claude-sonnet-4-6",
      "gemini-claude-opus-4-6",
      "gemini-gpt-oss-120b",
    ]);
  });

  it("round-trips the discovered catalog while filtering unsupported stored entries", () => {
    const catalog = catalogFromAvailableModels(availableModels()) ?? [];
    const configs = modelConfigs(catalog);
    const stored = storedModelsFrom(configs, "antigravity", "https://example.test");
    const first = stored[0]!;

    const ignored = [
      { ...first, id: "claude-opus-4-6" },
      { ...first, id: "gemini-other-provider", provider: "other-provider" },
      { ...first, id: "gemini-other-api", api: "openai-completions" },
    ];

    const restored = modelsFromStored([...stored, ...ignored], "antigravity");

    expect(stored).toEqual(
      expect.arrayContaining(
        catalog.map((model) =>
          expect.objectContaining({
            id: model.id,
            provider: "antigravity",
            api: "antigravity",
            baseUrl: "https://example.test",
            thinkingLevelMap: model.thinkingLevelMap,
          }),
        ),
      ),
    );
    expect(restored?.map((model) => model.id)).toEqual(catalog.map((model) => model.id));
  });

  it("returns no catalog for empty stored input", () => {
    expect(modelsFromStored([], "antigravity")).toBeUndefined();
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

    expect(catalog).toHaveLength(0);
    expect(API_KEY).toContain("access-token");
  });
});
