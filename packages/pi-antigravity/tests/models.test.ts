import { describe, expect, it } from "vite-plus/test";

import {
  FALLBACK_MODELS,
  PROVIDER_ID,
  modelConfigs,
  requiresThoughtSignature,
  resolveRuntimeModel,
  thinkingConfig,
} from "../src/models";

describe("model catalog", () => {
  it("does not advertise a stale static catalog", () => {
    expect(FALLBACK_MODELS).toEqual([]);
    expect(modelConfigs()).toEqual([]);
  });
});

describe("runtime model routing", () => {
  it("routes dynamically registered Gemini models", () => {
    const model = {
      id: "gemini-3.8-flash",
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: "gemini-3.8-flash-low",
        medium: "gemini-3.8-flash-medium",
        high: "gemini-3.8-flash-high",
        xhigh: null,
        max: null,
      },
    } as const;

    expect(resolveRuntimeModel(model, "low")).toBe("gemini-3.8-flash-low");
    expect(resolveRuntimeModel(model)).toBe("gemini-3.8-flash-medium");
  });

  it("routes a model Pi registered itself", () => {
    const registered = {
      id: "gemini-4-neon",
      thinkingLevelMap: { off: "gemini-4-neon", high: "gemini-4-neon-high" },
    };

    expect(resolveRuntimeModel(registered, "high")).toBe("gemini-4-neon-high");
    expect(resolveRuntimeModel(registered, "off")).toBe("gemini-4-neon");
    expect(resolveRuntimeModel({ id: "unknown-model" }, "high")).toBe("unknown-model");
  });
});

describe("request capabilities", () => {
  it("requires thought signatures only for Gemini 3 and newer", () => {
    expect(requiresThoughtSignature("gemini-3.8-flash-high")).toBe(true);
    expect(requiresThoughtSignature("gemini-2.5-pro")).toBe(false);
  });

  it("builds Gemini thinking settings", () => {
    expect(thinkingConfig("gemini-3.8-flash-high", "off")).toEqual({
      includeThoughts: false,
      thinkingBudget: 0,
    });
    expect(thinkingConfig("gemini-3.8-flash-high", "high")).toEqual({
      includeThoughts: true,
      thinkingLevel: "HIGH",
    });
    expect(thinkingConfig("unknown-model-1", "high")).toBeUndefined();
    expect(PROVIDER_ID).toBe("antigravity");
  });
});
