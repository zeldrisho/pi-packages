import type { Credential, JsonValue, RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fetchAgyModels } from "./agy-models.ts";
import {
  catalogFromAvailableModels,
  fetchAvailableModels,
  modelsFromStored,
  storedModelsFrom,
} from "./discovery.ts";
import { nonEmptyText } from "./json.ts";
import { fetchGeminiMetadata, restorePiSnapshots } from "./pi-catalog.ts";
import {
  ANTIGRAVITY_API,
  FALLBACK_MODELS,
  PROVIDER_ID,
  PROVIDER_NAME,
  modelConfigs,
} from "./models.ts";
import { getApiKey, loginAntigravity, parseApiKey, refreshCredentials } from "./oauth.ts";
import { ENDPOINTS } from "./project.ts";
import { createAntigravityStream } from "./stream.ts";
import { createThinkingMetadataResolver } from "./thinking-metadata.ts";

/** Catalog freshness window; a refresh inside it reuses the stored catalog. */
const CATALOG_TTL_MS = 4 * 60 * 60 * 1000;

/**
 * Resolves the request credential carried by a refresh context.
 *
 * Discovery needs the project the account is billed against, so a credential
 * without one is treated as unavailable rather than guessed at.
 *
 * @param credential - Credential Pi resolved for this provider
 * @returns The token and project id, or undefined when either is missing
 */
function apiKeyFrom(
  credential: Credential | undefined,
): ReturnType<typeof parseApiKey> | undefined {
  if (credential === undefined) return undefined;

  if (credential.type === "api_key") {
    return credential.key === undefined ? undefined : parseApiKey(credential.key);
  }

  // SAFETY: OAuth credentials persist the project id as a JSON string field.
  const project = nonEmptyText(credential.projectId as JsonValue | undefined);

  if (project === undefined) return undefined;

  return parseApiKey(getApiKey(credential));
}

/**
 * Refreshes the model catalog through Pi's model-store publication flow.
 *
 * A stored catalog younger than the freshness window is reused unless the
 * caller forces a refresh. Discovery failures keep the previous catalog.
 *
 * @param context - Refresh context from Pi
 * @returns Model configurations to register, replacing extension-provided models
 */
async function refreshModels(
  context: RefreshModelsContext,
): Promise<ReturnType<typeof modelConfigs>> {
  const storedModels = modelsFromStored(context.stored?.models, PROVIDER_ID);

  // SAFETY: the provider-owned field is persisted as JSON and validated before use.
  const storedCatalog = (context.stored as typeof context.stored & { piCatalog?: JsonValue })
    ?.piCatalog;

  const snapshots = restorePiSnapshots(storedCatalog);

  const fresh =
    context.force !== true &&
    storedModels !== undefined &&
    snapshots.google !== undefined &&
    snapshots.vertex !== undefined &&
    context.stored?.checkedAt !== undefined &&
    context.stored.checkedAt <= Date.now() &&
    Date.now() - context.stored.checkedAt < CATALOG_TTL_MS;

  if (fresh) return modelConfigs(storedModels);

  const fallback = modelConfigs(storedModels ?? FALLBACK_MODELS);

  if (!context.allowNetwork || context.signal.aborted) return fallback;

  const apiKey = apiKeyFrom(context.credential);

  if (apiKey === undefined) return fallback;

  const cliFallback = async (): Promise<ReturnType<typeof modelConfigs>> => {
    if (storedModels !== undefined || context.signal.aborted) return fallback;

    const models = await fetchAgyModels(context.signal);

    return models === undefined ? fallback : modelConfigs(models);
  };

  const body = await fetchAvailableModels(apiKey.token, apiKey.projectId, context.signal);

  if (body === undefined || context.signal.aborted) return cliFallback();
  const metadata = await fetchGeminiMetadata(context.signal, snapshots);
  const catalog = catalogFromAvailableModels(body, FALLBACK_MODELS, metadata.models);

  if (catalog === undefined || context.signal.aborted) return cliFallback();

  const configs = modelConfigs(catalog);

  if (!metadata.completed) {
    if (metadata.httpStatus !== undefined)
      throw new Error(`Pi model catalog refresh failed (HTTP ${metadata.httpStatus}).`);

    return configs;
  }

  const baseUrl = context.baseUrl ?? ENDPOINTS[0];

  const entry = {
    models: storedModelsFrom(configs, PROVIDER_ID, baseUrl),
    checkedAt: Date.now(),
    piCatalog: metadata.snapshots,
  };

  try {
    await context.publish({ persist: entry });
  } catch {
    // Keep the in-memory catalog when Pi cannot persist it.
  }

  if (metadata.httpStatus !== undefined)
    throw new Error(`Pi model catalog refresh failed (HTTP ${metadata.httpStatus}).`);

  return configs;
}

/**
 * Registers the Antigravity provider, its Google OAuth login, its model
 * discovery, and its streaming adapter.
 *
 * @param pi - Extension API supplied by Pi
 */
export default function antigravityExtension(pi: ExtensionAPI): void {
  pi.registerProvider(PROVIDER_ID, {
    name: PROVIDER_NAME,
    baseUrl: ENDPOINTS[0],
    api: ANTIGRAVITY_API,
    models: modelConfigs(),
    streamSimple: createAntigravityStream(createThinkingMetadataResolver()),
    refreshModels,
    oauth: {
      name: `${PROVIDER_NAME} (Google account)`,
      isSubscription: true,
      login: (callbacks) => loginAntigravity(callbacks),
      refreshToken: (credentials, signal) => refreshCredentials(credentials, signal, Date.now()),
      getApiKey: (credentials) => getApiKey(credentials),
    },
  });
}

export { FALLBACK_MODELS, PROVIDER_ID, PROVIDER_NAME, resolveRuntimeModel } from "./models.ts";

export { catalogFromAvailableModels, resolveCatalog } from "./discovery.ts";

export { buildRequest, buildContents, normalizeSchema, legacySchema } from "./request.ts";

export { decodeChunk, describeFailure } from "./stream.ts";

export {
  parsePastedCallback,
  createPkcePair,
  buildAuthUrl,
  parseApiKey,
  getApiKey,
} from "./oauth.ts";
