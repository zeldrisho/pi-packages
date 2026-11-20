import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { catalogThinkingConfig, createThinkingMetadataResolver } from "../src/thinking-metadata";

const body = {
  models: {
    "future-low": { supportsThinking: true, thinkingLevel: 1, thinkingBudget: 999 },
    "future-high": { supportsThinking: true, thinkingLevel: 3 },
    fixed: { supportsThinking: true, thinkingBudget: 8192 },
    unsupported: { supportsThinking: true, thinkingLevel: 99, thinkingBudget: 42 },
  },
};

afterEach(() => vi.unstubAllGlobals());

describe("catalog thinking metadata", () => {
  it("uses the catalog's wire level in preference to a budget", () => {
    expect(catalogThinkingConfig(body, "future-low")).toEqual({
      includeThoughts: true,
      thinkingLevel: "LOW",
    });
    expect(catalogThinkingConfig(body, "future-high")).toEqual({
      includeThoughts: true,
      thinkingLevel: "HIGH",
    });
    expect(catalogThinkingConfig(body, "fixed")).toEqual({
      includeThoughts: true,
      thinkingBudget: 8192,
    });
    expect(catalogThinkingConfig(body, "unsupported")).toBeUndefined();
    expect(catalogThinkingConfig(body, "missing")).toBeUndefined();
  });

  it("caches by credential and project, and refetches after account changes", async () => {
    const fetch = vi.fn(async () => Response.json(body));
    vi.stubGlobal("fetch", fetch);
    const resolve = createThinkingMetadataResolver();

    expect(await resolve("token-a", "project", "future-low", undefined)).toEqual({
      includeThoughts: true,
      thinkingLevel: "LOW",
    });
    expect(await resolve("token-a", "project", "fixed", undefined)).toEqual({
      includeThoughts: true,
      thinkingBudget: 8192,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    await resolve("token-b", "project", "fixed", undefined);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("uses an explicit fetch override for live metadata", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("global fetch must not be used");
    });
    const fetcher = vi.fn(async () => Response.json(body));
    const resolve = createThinkingMetadataResolver();

    await expect(resolve("token", "project", "future-high", undefined, fetcher)).resolves.toEqual({
      includeThoughts: true,
      thinkingLevel: "HIGH",
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("does not cache a failed discovery", async () => {
    const fetch = vi.fn(async () => new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    const resolve = createThinkingMetadataResolver();

    expect(await resolve("token", "project", "fixed", undefined)).toBeUndefined();
    expect(await resolve("token", "project", "fixed", undefined)).toBeUndefined();
    expect(fetch.mock.calls.length).toBeGreaterThan(2);
  });
});
