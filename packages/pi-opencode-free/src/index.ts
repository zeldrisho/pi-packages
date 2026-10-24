import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";

import { createCliVersionResolver } from "./cli-version.ts";
import {
  buildFingerprintHeaders,
  createCanonicalSessionId,
  createSessionSeed,
} from "./fingerprint.ts";
import {
  DEFAULT_BASE_URL,
  configsFromStoredModels,
  discoverFreeModelsWithStatus,
  initialFreeModels,
  storedModelsFromConfigs,
  stripTrailingSlashes,
  type FreeChatModelConfig,
} from "./models.ts";
import { createFreeStream } from "./stream.ts";

/** Provider id used by `/model` and the provider-scoped request adapter. */
export const PROVIDER_ID = "opencode-free";

const DISCOVERY_TIMEOUT_MS = 8_000;

/** Injectable runtime dependencies used by tests and the default extension export. */
export interface OpencodeFreeDependencies {
  randomSeed: () => Uint8Array;
  fetcher: typeof fetch;
}

/**
 * Registers the OpenCode free provider and its request adapter.
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

  const resolveVersion = createCliVersionResolver(dependencies.fetcher);
  const initialModels = initialFreeModels();

  pi.on("session_start", () => {
    sessionId = createCanonicalSessionId(dependencies.randomSeed());
  });

  const config: ProviderConfig = {
    name: "OpenCode Free",
    baseUrl: DEFAULT_BASE_URL,
    apiKey: "public",
    api: "openai-completions",
    authHeader: true,
    models: initialModels,
    streamSimple: createFreeStream(dependencies.fetcher, async (signal) => {
      const cliVersion = await resolveVersion(signal);

      return { sessionId, cliVersion };
    }),
    refreshModels: async (context) =>
      refreshModels(context, dependencies, sessionId, resolveVersion),
  };

  pi.registerProvider(PROVIDER_ID, config);
}

/**
 * Refreshes the catalog, falling back to stored models or bundled models when
 * offline, canceled, or discovery returns no usable models. Discovery has an
 * eight-second abort deadline. Successful results are published for persistence;
 * publication failures are ignored and the discovered models are still returned.
 */
async function refreshModels(
  context: RefreshModelsContext,
  dependencies: OpencodeFreeDependencies,
  sessionId: string,
  resolveVersion: (signal?: AbortSignal) => Promise<string>,
): Promise<FreeChatModelConfig[]> {
  const baseUrl = stripTrailingSlashes(context.baseUrl ?? DEFAULT_BASE_URL);
  const cachedModels = configsFromStoredModels(context.stored?.models ?? [], PROVIDER_ID);
  const fallbackModels = cachedModels.length > 0 ? cachedModels : initialFreeModels();

  if (!context.allowNetwork || context.signal.aborted) return fallbackModels;

  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)]);
  let cliVersion: string;

  try {
    cliVersion = await resolveVersion(signal);
  } catch {
    return fallbackModels;
  }

  const outcome = await discoverFreeModelsWithStatus({
    baseUrl,
    headers: buildFingerprintHeaders(sessionId, cliVersion),
    signal,
    fetcher: dependencies.fetcher,
    allowNetwork: context.allowNetwork,
  });

  if (!outcome.models || context.signal.aborted) return fallbackModels;

  const models = outcome.models;

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
};

/**
 * Pi extension entry point. Registers the `opencode-free` provider.
 *
 * @param pi - Extension API supplied by Pi
 */
export default function piOpencodeFree(pi: ExtensionAPI): void {
  registerOpencodeFree(pi, defaultDependencies);
}
