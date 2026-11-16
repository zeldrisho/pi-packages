import { describe, expect, it } from "vite-plus/test";

import {
  FALLBACK_MODELS,
  PROVIDER_ID,
  findModel,
  modelConfigs,
  requiresThoughtSignature,
  resolveRuntimeModel,
  thinkingConfig,
  usesLegacyToolSchema,
} from "../src/models";

const gemini = findModel("gemini-3.8-flash");

const claude = findModel("claude-opus-4-6");

const gptOss = findModel("gpt-oss-120b");

describe("model catalog", () => {
  it("matches the models the Antigravity CLI advertises", () => {
    expect(FALLBACK_MODELS.map((model) => model.id)).toEqual([
      "gemini-3.8-flash",
      "claude-sonnet-4-6",
      "claude-opus-4-6",
      "gpt-oss-120b",
    ]);
  });

  it("registers every model against the Antigravity API with zero cost", () => {
    const configs = modelConfigs();

    expect(configs).toHaveLength(FALLBACK_MODELS.length);

    for (const config of configs) {
      expect(config.api).toBe("antigravity");
      expect(config.reasoning).toBe(true);
      expect(config.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      expect(config.contextWindow).toBeGreaterThan(0);
      expect(config.maxTokens).toBeGreaterThan(0);
    }
  });

  it("exposes image input only for models that accept it", () => {
    expect(modelConfigs().find((config) => config.id === "gpt-oss-120b")?.input).toEqual(["text"]);
    expect(modelConfigs().find((config) => config.id === "gemini-3.8-flash")?.input).toEqual([
      "text",
      "image",
    ]);
  });
});

describe("runtime model routing", () => {
  it("routes Gemini thinking levels to the tiered runtime ids", () => {
    expect(gemini).toBeDefined();

    if (gemini === undefined) return;

    expect(resolveRuntimeModel(gemini, "low")).toBe("gemini-3.8-flash-low");
    expect(resolveRuntimeModel(gemini, "medium")).toBe("gemini-3.8-flash-medium");
    expect(resolveRuntimeModel(gemini, "high")).toBe("gemini-3.8-flash-high");
    expect(gemini.thinkingLevelMap.max).toBeNull();
    expect(resolveRuntimeModel(gemini)).toBe("gemini-3.8-flash-medium");
  });

  it("keeps Claude Opus on its thinking runtime id at every level", () => {
    expect(claude).toBeDefined();

    if (claude === undefined) return;

    for (const level of ["off", "low", "high"] as const) {
      expect(resolveRuntimeModel(claude, level)).toBe("claude-opus-4-6-thinking");
    }
  });

  it("marks unadvertised Claude effort levels unsupported", () => {
    expect(claude).toBeDefined();

    if (claude === undefined) return;

    const map = claude.thinkingLevelMap;

    expect(map.high).toBe("claude-opus-4-6-thinking");
    expect(map.max).toBeNull();
    expect(map.medium).toBeNull();
    expect(Object.keys(map).sort()).toEqual([
      "high",
      "low",
      "max",
      "medium",
      "minimal",
      "off",
      "xhigh",
    ]);
  });

  it("routes a model Pi registered itself, not only catalog entries", () => {
    const registered = {
      id: "claude-sonnet-4-6",
      thinkingLevelMap: { off: "claude-sonnet-4-6", high: "claude-sonnet-4-6-thinking" },
    };

    expect(resolveRuntimeModel(registered, "high")).toBe("claude-sonnet-4-6-thinking");
    expect(resolveRuntimeModel(registered, "off")).toBe("claude-sonnet-4-6");
    expect(resolveRuntimeModel({ id: "unknown-model" }, "high")).toBe("unknown-model");
  });
});

describe("request capabilities", () => {
  it("requires thought signatures only for Gemini 3 and newer", () => {
    expect(requiresThoughtSignature("gemini-3.8-flash-high")).toBe(true);
    expect(requiresThoughtSignature("gemini-2.5-pro")).toBe(false);
    expect(requiresThoughtSignature("claude-opus-4-6-thinking")).toBe(false);
  });

  it("uses the legacy tool schema only for Claude and GPT-OSS", () => {
    expect(usesLegacyToolSchema("claude-sonnet-4-6")).toBe(true);
    expect(usesLegacyToolSchema("gpt-oss-120b-medium")).toBe(true);
    expect(usesLegacyToolSchema("gemini-3.8-flash-low")).toBe(false);
  });

  it("omits thinking when it is off and budgets by model family", () => {
    expect(thinkingConfig("gemini-3.8-flash-high", "off")).toEqual({
      includeThoughts: false,
      thinkingBudget: 0,
    });
    expect(thinkingConfig("gemini-3.8-flash-high", undefined)).toEqual({
      includeThoughts: false,
      thinkingBudget: 0,
    });
    expect(thinkingConfig("claude-opus-4-6-thinking", "high")).toEqual({
      includeThoughts: true,
      thinkingBudget: 1024,
    });
    expect(thinkingConfig("gpt-oss-120b-medium", "low")).toEqual({
      includeThoughts: true,
      thinkingBudget: 8192,
    });
    expect(thinkingConfig("gemini-3.8-flash-high", "high")).toEqual({
      includeThoughts: true,
      thinkingLevel: "HIGH",
    });
    expect(thinkingConfig("gemini-3.8-flash-medium", "medium")).toEqual({
      includeThoughts: true,
      thinkingLevel: "MEDIUM",
    });
    expect(thinkingConfig("gemini-3.8-flash-low", "low")).toEqual({
      includeThoughts: true,
      thinkingLevel: "LOW",
    });
    expect(thinkingConfig("unknown-model-1", "high")).toBeUndefined();
  });

  it("keeps GPT-OSS text-only and identified by the provider id", () => {
    expect(gptOss?.input).toEqual(["text"]);
    expect(PROVIDER_ID).toBe("antigravity");
  });
});
