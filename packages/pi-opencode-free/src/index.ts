import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";

import {
  applyFingerprintHeaders,
  buildFingerprintHeaders,
  createCanonicalSessionId,
  createSessionSeed,
  resolveCliVersion,
} from "./fingerprint.ts";
import {
  configsFromStoredModels,
  discoverFreeModels,
  initialFreeModels,
  resolveApiKey,
  resolveBaseUrl,
  storedModelsFromConfigs,
  stripTrailingSlashes,
  type FreeChatModelConfig,
} from "./models.ts";
import { isProviderRequestPayload, normalizeFreeRequestPayload } from "./request.ts";

/** Provider id used by `/model` and provider-scoped request handlers. */
export const PROVIDER_ID = "opencode-free";

const DISCOVERY_TIMEOUT_MS = 8_000;

/** Injectable runtime dependencies used by tests and the default extension export. */
export interface OpencodeFreeDependencies {
  randomSeed: () => Uint8Array;
  fetcher: typeof fetch;
  environment: Record<string, string | undefined>;
}

/**
 * Registers the OpenCode free provider and its request hooks.
 *
 * Seeds the catalog from bundled models, rotates session identity on session
 * start, and normalizes requests for this provider. Discovery runs when Pi
 * invokes the registered model refresh hook.
 *
 * @param pi - Extension API supplied by Pi
 * @param dependencies - Runtime dependencies for discovery and session generation
 * @throws If seed generation fails or returns fewer than twenty bytes; Pi API errors propagate
 */
export function registerOpencodeFree(
  pi: ExtensionAPI,
  dependencies: OpencodeFreeDependencies,
): void {
  let sessionId = createCanonicalSessionId(dependencies.randomSeed());

  const baseUrl = resolveBaseUrl(dependencies.environment);
  const apiKey = resolveApiKey(dependencies.environment);
  const cliVersion = resolveCliVersion(dependencies.environment);

  pi.on("session_start", () => {
    sessionId = createCanonicalSessionId(dependencies.randomSeed());
  });

  pi.on("before_provider_headers", (event) => {
    applyFingerprintHeaders(event.headers, sessionId, cliVersion);
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (ctx.model?.provider !== PROVIDER_ID) return undefined;

    if (!isProviderRequestPayload(event.payload)) return undefined;

    return normalizeFreeRequestPayload(event.payload);
  });

  const config: ProviderConfig = {
    name: "OpenCode Free",
    baseUrl,
    apiKey,
    api: "openai-completions",
    authHeader: true,
    headers: buildFingerprintHeaders(sessionId, cliVersion),
    models: initialFreeModels(),
    refreshModels: async (context) =>
      refreshModels(context, dependencies, baseUrl, sessionId, cliVersion),
  };

  pi.registerProvider(PROVIDER_ID, config);
}

/**
 * Refreshes the catalog, falling back to stored models or bundled models when
 * offline, canceled, or discovery returns no usable models. Discovery has an
 * eight-second abort deadline. Successful results are published for persistence;
 * publication failures are ignored and the discovered models are still returned.
 *
 * @param fallbackBaseUrl - Endpoint used when the refresh context has no override
 * @throws Propagates model metadata conversion errors from discovery
 */
async function refreshModels(
  context: RefreshModelsContext,
  dependencies: OpencodeFreeDependencies,
  fallbackBaseUrl: string,
  sessionId: string,
  cliVersion: string,
): Promise<FreeChatModelConfig[]> {
  const baseUrl = stripTrailingSlashes(context.baseUrl ?? fallbackBaseUrl);
  const cachedModels = configsFromStoredModels(context.stored?.models ?? [], PROVIDER_ID);
  const fallbackModels = cachedModels.length > 0 ? cachedModels : initialFreeModels();

  if (!context.allowNetwork || context.signal.aborted) return fallbackModels;

  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)]);

  const models = await discoverFreeModels({
    baseUrl,
    headers: buildFingerprintHeaders(sessionId, cliVersion),
    signal,
    fetcher: dependencies.fetcher,
    allowNetwork: context.allowNetwork,
  });

  if (!models || context.signal.aborted) return fallbackModels;

  try {
    await context.publish({
      persist: {
        models: storedModelsFromConfigs(models, PROVIDER_ID, baseUrl),
        checkedAt: Date.now(),
      },
    });
  } catch {
    // Keep a valid in-memory catalog even when persistent storage is unavailable.
  }

  return models;
}

const defaultDependencies: OpencodeFreeDependencies = {
  randomSeed: createSessionSeed,
  fetcher: globalThis.fetch,
  environment: process.env,
};

/**
 * Pi extension entry point. Registers the `opencode-free` provider.
 *
 * @param pi - Extension API supplied by Pi
 */
export default function piOpencodeFree(pi: ExtensionAPI): void {
  registerOpencodeFree(pi, defaultDependencies);
}
