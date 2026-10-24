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
  catalogFromStoredEntry,
  configsFromStoredModels,
  discoverFreeModelsWithStatus,
  initialFreeModels,
  storedModelsFromConfigs,
  stripTrailingSlashes,
  type FreeChatModelConfig,
  type FreeModelsStoreEntry,
} from "./models.ts";
import { createFreeStream } from "./stream.ts";

/** Provider id used by `/model` and the provider-scoped request adapter. */
export const PROVIDER_ID = "opencode-free";

const DISCOVERY_TIMEOUT_MS = 8_000;

const CATALOG_TTL_MS = 4 * 60 * 60 * 1000;

interface CatalogRefreshState {
  cached?: {
    baseUrl: string;
    entry: FreeModelsStoreEntry;
  };
}

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
  const refreshState: CatalogRefreshState = {};

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
      refreshModels(context, dependencies, sessionId, resolveVersion, refreshState),
  };

  pi.registerProvider(PROVIDER_ID, config);
}

/**
 * Refreshes the catalog, falling back to stored models or bundled models when
 * offline, canceled, version resolution fails, or discovery returns no usable
 * models. Version resolution and discovery share an eight-second abort deadline.
 * Like native Pi, catalogs with lastModified (including zero) and a valid checkedAt
 * stay fresh for four hours after checkedAt. Force bypasses freshness, never
 * offline mode or cancellation. HTTP failures
 * retain the body and validators while advancing checkedAt; first failures without
 * Last-Modified remain immediately retryable. Transport, parsing, version lookup,
 * and cancellation failures do not advance freshness. Snapshots are endpoint-scoped.
 * Publication errors are ignored and the snapshot is retained in memory unless
 * the caller canceled; a refused publication does not update the in-memory cache.
 *
 * @throws {Error} If discovery reports an HTTP failure, after attempting to publish the
 *   updated checkedAt with any existing body and validators
 */
async function refreshModels(
  context: RefreshModelsContext,
  dependencies: OpencodeFreeDependencies,
  sessionId: string,
  resolveVersion: (signal?: AbortSignal) => Promise<string>,
  state: CatalogRefreshState,
): Promise<FreeChatModelConfig[]> {
  const baseUrl = stripTrailingSlashes(context.baseUrl ?? DEFAULT_BASE_URL);
  const memory = state.cached?.baseUrl === baseUrl ? state.cached : undefined;

  const storedModels = configsFromStoredModels(
    (context.stored?.models ?? []).filter(
      (model) => stripTrailingSlashes(model.baseUrl) === baseUrl,
    ),
    PROVIDER_ID,
  );

  const stored = memory?.entry ?? (storedModels.length > 0 ? context.stored : undefined);

  const cachedModels = memory
    ? configsFromStoredModels(memory.entry.models, PROVIDER_ID)
    : storedModels;

  const fallbackModels = cachedModels.length > 0 ? cachedModels : initialFreeModels();

  if (!context.allowNetwork || context.signal.aborted) return fallbackModels;

  const now = Date.now();

  if (
    !context.force &&
    stored?.lastModified !== undefined &&
    isRecent(stored.checkedAt, now, CATALOG_TTL_MS)
  ) {
    return fallbackModels;
  }

  /** Publishes a snapshot and caches it unless refused or canceled; publication errors are ignored. */
  const publish = async (entry: FreeModelsStoreEntry): Promise<void> => {
    let accepted = true;

    try {
      accepted = await context.publish({ persist: entry });
    } catch {
      // Keep a valid in-memory catalog even when persistent storage is unavailable.
    }

    if (accepted && !context.signal.aborted) state.cached = { baseUrl, entry };
  };

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
    catalog: catalogFromStoredEntry(stored),
  });

  if (signal.aborted) return fallbackModels;

  if (outcome.httpStatus !== undefined) {
    await publish({ ...(stored ?? { models: [] }), checkedAt: Date.now() });
    throw new Error(
      `OpenCode Free model discovery failed (${outcome.status}): HTTP ${outcome.httpStatus}`,
    );
  }

  if (!outcome.models || !outcome.catalog) return fallbackModels;

  await publish({
    models: storedModelsFromConfigs(outcome.models, PROVIDER_ID, baseUrl),
    catalog: outcome.catalog.models,
    checkedAt: Date.now(),
    lastModified: outcome.catalog.lastModified,
    etag: outcome.catalog.etag,
  });

  return outcome.models;
}

/**
 * Accepts nonnegative epoch-millisecond timestamps no later than now and less
 * than ttl milliseconds old; missing, nonfinite, and future timestamps fail.
 */
function isRecent(timestamp: number | undefined, now: number, ttl: number): boolean {
  return (
    timestamp !== undefined &&
    Number.isFinite(timestamp) &&
    timestamp >= 0 &&
    timestamp <= now &&
    now - timestamp < ttl
  );
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
