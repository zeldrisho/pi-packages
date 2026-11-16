import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import antigravityExtension, { FALLBACK_MODELS, PROVIDER_ID } from "../src/index";
import { storedModelsFrom } from "../src/discovery";
import { modelConfigs } from "../src/models";

interface Registration {
  name: string;
  config: ProviderConfig;
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
  it("refreshes and publishes a discovered catalog", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          models: { "example-low": { displayName: "Example (Low)", maxTokens: 120000 } },
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

    expect(models?.map((model) => model.id)).toEqual(["example"]);
    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith({
      persist: expect.objectContaining({ checkedAt: expect.any(Number) }),
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

    const context: RefreshModelsContext = {
      stored: {
        models: storedModelsFrom(
          modelConfigs(FALLBACK_MODELS.slice(0, 1)),
          PROVIDER_ID,
          "https://example.test",
        ),
        checkedAt: Date.now(),
      },
      allowNetwork: true,
      signal: new AbortController().signal,
      publish,
    };

    expect(await register().config.refreshModels?.(context)).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("registers the Antigravity provider once", () => {
    const { name, config } = register();

    expect(name).toBe(PROVIDER_ID);
    expect(config.name).toBe("Antigravity");
    expect(config.api).toBe("antigravity");
    expect(config.baseUrl).toBe("https://daily-cloudcode-pa.googleapis.com");
  });

  it("registers the catalog and a streaming adapter", () => {
    const { config } = register();

    expect(config.models?.map((model) => model.id)).toEqual(
      FALLBACK_MODELS.map((model) => model.id),
    );
    expect(config.streamSimple).toBeTypeOf("function");
  });

  it("offers Google sign-in backed by a subscription", () => {
    const { config } = register();

    expect(config.oauth?.name).toContain("Google account");
    expect(config.oauth?.isSubscription).toBe(true);
    expect(Object.keys(config.oauth ?? {})).toEqual(
      expect.arrayContaining(["login", "refreshToken", "getApiKey"]),
    );
  });

  it("refreshes OAuth credentials through the registered provider", async () => {
    vi.stubEnv("PI_ANTIGRAVITY_CLIENT_ID", "test-client-id");
    vi.stubEnv("PI_ANTIGRAVITY_CLIENT_SECRET", "test-client-secret");
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
