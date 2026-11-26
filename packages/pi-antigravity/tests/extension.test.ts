import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import antigravityExtension, { FALLBACK_MODELS, PROVIDER_ID } from "../src/index";
import { storedModelsFrom } from "../src/discovery";
import { modelConfigs, type AntigravityModel } from "../src/models";

vi.mock("../src/agy-client", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/agy-client")>();

  return {
    ...original,
    discoverAgyClient: vi.fn(async () => ({ id: "test-client-id", secret: "test-client-secret" })),
  };
});

interface Registration {
  name: string;
  config: ProviderConfig;
}

function storedGeminiModels() {
  const model: AntigravityModel = {
    id: "gemini-stored",
    name: "Stored Gemini",
    reasoning: true,
    input: ["text"],
    contextWindow: 128_000,
    maxTokens: 32_768,
    thinkingLevelMap: { off: "gemini-stored" },
  };

  return storedModelsFrom(modelConfigs([model]), PROVIDER_ID, "https://example.test");
}

function register(): Registration {
  let registration: Registration | undefined;

  const pi = {
    registerProvider: (name: string, config: ProviderConfig): void => {
      registration = { name, config };
    },
  };

  // SAFETY: the fake exposes the single ExtensionAPI member this extension calls.
  antigravityExtension(pi as ExtensionAPI);

  if (registration === undefined) throw new Error("provider was not registered");

  return registration;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("extension registration", () => {
  it("uses bundled models when online discovery fails without a stored catalog", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );

    const models = await register().config.refreshModels?.({
      credential: {
        type: "api_key",
        key: JSON.stringify({ token: "token", projectId: "project" }),
      },
      allowNetwork: true,
      signal: new AbortController().signal,
      publish: vi.fn(async () => true),
    });

    expect(models?.map((model) => model.id)).toEqual(FALLBACK_MODELS.map((model) => model.id));
  });
  it("refreshes and publishes a discovered catalog", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.startsWith("https://pi.dev/")
          ? Response.json([])
          : Response.json({
              models: { "gemini-example-low": { displayName: "Example (Low)", maxTokens: 120000 } },
            }),
      ),
    );
    const publish = vi.fn(async () => true);

    const context: RefreshModelsContext = {
      credential: {
        type: "oauth",
        access: "token",
        refresh: "refresh",
        expires: 9999999999999,
        projectId: "project",
      },
      allowNetwork: true,
      signal: new AbortController().signal,
      publish,
    };

    const models = await register().config.refreshModels?.(context);

    expect(models?.map((model) => model.id)).toEqual(["gemini-example"]);
    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith({
      persist: expect.objectContaining({ checkedAt: expect.any(Number) }),
    });
  });

  it("uses live pi.dev Gemini metadata without forwarding Antigravity credentials", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (url.startsWith("https://pi.dev/")) {
          expect(new Headers(init.headers).has("authorization")).toBe(false);

          return Response.json(
            [
              {
                id: "gemini-3.8-flash",
                reasoning: true,
                input: ["text"],
                contextWindow: 50000,
                maxTokens: 4000,
                thinkingLevelMap: {
                  off: null,
                  minimal: null,
                  low: "low",
                  medium: null,
                  high: "high",
                  xhigh: null,
                  max: null,
                },
              },
            ],
            { headers: { "last-modified": "Wed, 21 Oct 2099 07:28:00 GMT" } },
          );
        }

        return Response.json({
          models: {
            "gemini-3.8-flash-low": {
              displayName: "Gemini 3.8 Flash (Low)",
              maxTokens: 100000,
              maxOutputTokens: 8000,
            },
            "gemini-3.8-flash-medium": {
              displayName: "Gemini 3.8 Flash (Medium)",
              maxTokens: 100000,
              maxOutputTokens: 8000,
            },
          },
        });
      }),
    );
    const publish = vi.fn(async () => true);

    const models = await register().config.refreshModels?.({
      credential: {
        type: "oauth",
        access: "token",
        refresh: "refresh",
        expires: 9999999999999,
        projectId: "project",
      },
      allowNetwork: true,
      signal: new AbortController().signal,
      publish,
    });

    expect(models?.[0]).toMatchObject({
      contextWindow: 50000,
      maxTokens: 4000,
      input: ["text"],
      thinkingLevelMap: { low: "gemini-3.8-flash-low", medium: null },
    });
    expect(publish).toHaveBeenCalledOnce();
  });

  it("persists dynamically discovered budget levels in the catalog", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.startsWith("https://pi.dev/")
          ? Response.json([])
          : Response.json({
              models: {
                "gemini-claude-sonnet-4-6": {
                  displayName: "Claude Sonnet 4.6 (Thinking)",
                  supportsThinking: true,
                  thinkingBudget: 1024,
                },
              },
            }),
      ),
    );
    const publish = vi.fn(async () => true);

    const context: RefreshModelsContext = {
      credential: {
        type: "oauth",
        access: "token",
        refresh: "refresh",
        expires: 9999999999999,
        projectId: "project",
      },
      allowNetwork: true,
      signal: new AbortController().signal,
      publish,
    };

    const models = await register().config.refreshModels?.(context);
    expect(models?.[0]).toMatchObject({ thinkingLevelMap: { low: "gemini-claude-sonnet-4-6" } });
    expect(publish).toHaveBeenCalledWith({
      persist: expect.objectContaining({
        models: [
          expect.objectContaining({
            thinkingLevelMap: expect.objectContaining({ low: "gemini-claude-sonnet-4-6" }),
          }),
        ],
      }),
    });
  });

  it("does not mark fallback models fresh after failure or offline startup", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unavailable", { status: 503 })),
    );
    const publish = vi.fn(async () => true);

    const context: RefreshModelsContext = {
      credential: {
        type: "oauth",
        access: "token",
        refresh: "refresh",
        expires: 9999999999999,
        projectId: "project",
      },
      allowNetwork: true,
      signal: new AbortController().signal,
      publish,
    };

    const { config } = register();

    expect(await config.refreshModels?.(context)).toHaveLength(FALLBACK_MODELS.length);
    expect(await config.refreshModels?.({ ...context, allowNetwork: false })).toHaveLength(
      FALLBACK_MODELS.length,
    );
    expect(publish).not.toHaveBeenCalled();
  });

  it("uses a fresh stored catalog without network or publication", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const publish = vi.fn(async () => true);

    const stored = {
      models: storedGeminiModels(),
      checkedAt: Date.now(),
      piCatalog: {
        google: { entries: [], lastModified: 0 },
        vertex: { entries: [], lastModified: 0 },
      },
    };

    const context: RefreshModelsContext = {
      stored,
      credential: {
        type: "oauth",
        access: "token",
        refresh: "refresh",
        expires: 9999999999999,
        projectId: "project",
      },
      allowNetwork: true,
      signal: new AbortController().signal,
      publish,
    };

    expect(await register().config.refreshModels?.(context)).toMatchObject([
      expect.objectContaining({ id: "gemini-stored" }),
    ]);
    expect(fetch).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("refreshes a four-hour-old catalog and bypasses freshness on force, but never offline", async () => {
    const stored = {
      models: storedGeminiModels(),
      checkedAt: Date.now() - 4 * 60 * 60 * 1000,
      piCatalog: {
        google: { entries: [], lastModified: 0 },
        vertex: { entries: [], lastModified: 0 },
      },
    };

    const fetch = vi.fn(async (url: string) =>
      url.startsWith("https://pi.dev/")
        ? Response.json([])
        : Response.json({ models: { "gemini-example-low": { displayName: "Example (Low)" } } }),
    );

    vi.stubGlobal("fetch", fetch);
    const publish = vi.fn(async () => true);

    const context: RefreshModelsContext = {
      stored,
      credential: {
        type: "oauth",
        access: "token",
        refresh: "refresh",
        expires: 9999999999999,
        projectId: "project",
      },
      allowNetwork: true,
      signal: new AbortController().signal,
      publish,
    };

    const { config } = register();
    await config.refreshModels?.(context);
    expect(fetch).toHaveBeenCalledTimes(3);
    fetch.mockClear();
    await config.refreshModels?.({
      ...context,
      stored: { ...stored, checkedAt: Date.now() },
      force: true,
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    fetch.mockClear();
    await config.refreshModels?.({ ...context, force: true, allowNetwork: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not mark an incomplete pi.dev refresh fresh", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.startsWith("https://pi.dev/")
          ? Promise.reject(new Error("offline"))
          : Response.json({ models: { "gemini-example-low": { displayName: "Example (Low)" } } }),
      ),
    );
    const publish = vi.fn(async () => true);

    const models = await register().config.refreshModels?.({
      credential: {
        type: "oauth",
        access: "token",
        refresh: "refresh",
        expires: 9999999999999,
        projectId: "project",
      },
      allowNetwork: true,
      signal: new AbortController().signal,
      publish,
    });

    expect(models?.map((model) => model.id)).toEqual(["gemini-example"]);
    expect(publish).not.toHaveBeenCalled();
  });

  it("retains cached snapshots and reports HTTP refresh failures", async () => {
    const stored = {
      models: storedGeminiModels(),
      checkedAt: 1,
      piCatalog: {
        google: { entries: [], lastModified: 0 },
        vertex: { entries: [], lastModified: 0 },
      },
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.startsWith("https://pi.dev/")
          ? new Response(null, { status: 503 })
          : Response.json({ models: { "gemini-example-low": { displayName: "Example (Low)" } } }),
      ),
    );
    const publish = vi.fn(async () => true);

    const context: RefreshModelsContext = {
      stored,
      credential: {
        type: "oauth",
        access: "token",
        refresh: "refresh",
        expires: 9999999999999,
        projectId: "project",
      },
      allowNetwork: true,
      signal: new AbortController().signal,
      publish,
    };

    await expect(register().config.refreshModels?.(context)).rejects.toThrow("HTTP 503");
    expect(publish).toHaveBeenCalledWith({
      persist: expect.objectContaining({
        checkedAt: expect.any(Number),
        piCatalog: stored.piCatalog,
      }),
    });
  });

  it("registers the Antigravity provider with its catalog, streaming adapter, and Google sign-in", () => {
    const { name, config } = register();

    expect(name).toBe(PROVIDER_ID);
    expect(config.name).toBe("Antigravity");
    expect(config.api).toBe("antigravity");
    expect(config.baseUrl).toBe("https://daily-cloudcode-pa.googleapis.com");
    expect(config.models?.map((model) => model.id)).toEqual(
      FALLBACK_MODELS.map((model) => model.id),
    );
    expect(config.streamSimple).toBeTypeOf("function");
    expect(config.oauth?.name).toContain("Google account");
    expect(config.oauth?.isSubscription).toBe(true);
    expect(Object.keys(config.oauth ?? {})).toEqual(
      expect.arrayContaining(["login", "refreshToken", "getApiKey"]),
    );
  });

  it("refreshes OAuth credentials through the registered provider", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ access_token: "new-token", expires_in: 3600 })),
    );
    const { config } = register();
    const credentials = { access: "old", refresh: "refresh", expires: 1, projectId: "project" };

    await expect(
      config.oauth?.refreshToken(credentials, new AbortController().signal),
    ).resolves.toMatchObject({ access: "new-token", projectId: "project" });
  });

  it("projects stored credentials into the request API key", () => {
    const { config } = register();

    const apiKey = config.oauth?.getApiKey({
      access: "access-token",
      refresh: "refresh-token",
      expires: 0,
      projectId: "project-under-test",
    });

    expect(apiKey).toBeDefined();
    expect(JSON.parse(apiKey ?? "{}")).toEqual({
      token: "access-token",
      projectId: "project-under-test",
    });
  });
});
