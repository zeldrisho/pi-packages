import { isModelType, type AnyModel, type Api, type Model } from "@earendil-works/pi-ai";
import {
  getBuiltinModelDataGeneratedAt,
  getBuiltinModels,
} from "@earendil-works/pi-ai/providers/all";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

/** Default OpenAI-compatible OpenCode inference endpoint. */
export const DEFAULT_BASE_URL = "https://opencode.ai/inference/v1";

/** Pi's native OpenCode catalog overlay, as served by pi.dev. */
export const MODEL_CATALOG_URL = "https://pi.dev/api/models/providers/opencode?types=chat";

const DEFAULT_PUBLIC_API_KEY = "public";

/** Chat model configuration accepted by `ProviderConfig.models`. */
export type FreeChatModelConfig = Extract<ProviderModelConfig, { reasoning: boolean }>;

interface RemoteCost {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

interface RemoteCatalogEntry {
  id: string;
  type?: string;
  name?: string;
  api?: string;
  input?: readonly string[];
  cost?: RemoteCost;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  thinkingLevelMap?: FreeChatModelConfig["thinkingLevelMap"];
  compat?: FreeChatModelConfig["compat"];
  inputLimits?: FreeChatModelConfig["inputLimits"];
  promptCache?: FreeChatModelConfig["promptCache"];
}

interface LiveModel {
  id?: string;
}

interface LiveModelsResponse {
  data?: readonly LiveModel[];
}

/** Inputs for live free-model discovery. */
export interface DiscoverFreeModelsOptions {
  baseUrl: string;
  headers: Record<string, string>;
  signal: AbortSignal;
  fetcher: typeof fetch;
  allowNetwork: boolean;
}

/**
 * Removes trailing slash characters without a backtracking regular expression.
 *
 * @param value - URL text to normalize
 * @returns The value without trailing slashes
 */
export function stripTrailingSlashes(value: string): string {
  let end = value.length;

  while (end > 0 && value.charCodeAt(end - 1) === 0x2f) end -= 1;

  return value.slice(0, end);
}

/**
 * Resolves the provider base URL, allowing a local proxy or alternate gateway.
 *
 * @param environment - Environment variables visible to the extension
 * @returns The configured URL without trailing slashes, or the OpenCode default
 */
export function resolveBaseUrl(environment: Record<string, string | undefined>): string {
  const configured = environment.OPENCODE_FREE_BASE_URL?.trim();

  if (!configured) return DEFAULT_BASE_URL;

  return stripTrailingSlashes(configured);
}

/**
 * Resolves the bearer token used for inference requests.
 *
 * @param environment - Environment variables visible to the extension
 * @returns `OPENCODE_FREE_API_KEY`, then `OPENCODE_API_KEY`, then `public`
 */
export function resolveApiKey(environment: Record<string, string | undefined>): string {
  const freeKey = environment.OPENCODE_FREE_API_KEY?.trim();

  if (freeKey) return freeKey;

  const openCodeKey = environment.OPENCODE_API_KEY?.trim();

  return openCodeKey || DEFAULT_PUBLIC_API_KEY;
}

/**
 * Returns the free chat models in Pi's built-in OpenCode catalog.
 *
 * This seeds the provider before the first network refresh. The live catalog
 * replaces it as soon as discovery succeeds.
 *
 * @returns Free chat model configurations from Pi's bundled catalog
 */
export function initialFreeModels(): FreeChatModelConfig[] {
  return [...freeBuiltinModels().values()];
}

/**
 * Restores this provider's cached OpenAI-completions chat models from Pi's persisted store.
 * Model costs are preserved without checking whether they are zero.
 *
 * @param models - Models from `RefreshModelsContext.stored`
 * @param providerId - Provider id that owns the cached catalog
 * @returns Chat model configurations owned by this provider
 */
export function configsFromStoredModels(
  models: readonly AnyModel[],
  providerId: string,
): FreeChatModelConfig[] {
  const configs: FreeChatModelConfig[] = [];

  for (const model of models) {
    if (!isModelType(model, "chat")) continue;

    if (model.provider !== providerId) continue;

    if (model.api !== "openai-completions") continue;

    configs.push(fromModel(model));
  }

  return configs;
}

/**
 * Converts provider configurations into the catalog shape Pi persists.
 *
 * @param models - Discovered free chat models
 * @param providerId - Provider id that owns the catalog
 * @param baseUrl - Current provider base URL
 * @returns Full chat models suitable for `ModelsStoreEntry.models`
 */
export function storedModelsFromConfigs(
  models: readonly FreeChatModelConfig[],
  providerId: string,
  baseUrl: string,
): Model<"openai-completions">[] {
  return models.map((config) => {
    const model: Model<"openai-completions"> = {
      id: config.id,
      name: config.name,
      provider: providerId,
      api: "openai-completions",
      baseUrl,
      input: config.input,
      cost: config.cost,
      contextWindow: config.contextWindow,
      maxTokens: config.maxTokens,
      reasoning: config.reasoning,
    };

    if (config.thinkingLevelMap) model.thinkingLevelMap = config.thinkingLevelMap;

    if (config.compat) model.compat = config.compat;

    if (config.inputLimits) model.inputLimits = config.inputLimits;

    if (config.promptCache) model.promptCache = config.promptCache;

    return model;
  });
}

/**
 * Discovers free chat models from the live endpoint and Pi's native catalog.
 *
 * The live endpoint decides which models currently exist. Pi's OpenCode
 * catalog supplies their capabilities and compatibility flags, so this
 * extension does not maintain a second metadata translation.
 * A newer remote catalog overlays bundled metadata; otherwise bundled metadata
 * is used. Both endpoints must respond successfully. Fetch, HTTP, JSON parsing,
 * and response-shape failures return `undefined`, as do disabled networking,
 * an already-aborted signal, and an empty intersection.
 *
 * @param options - Endpoint, headers, abort signal, and fetcher
 * @returns Free chat model configurations, or `undefined` when discovery cannot verify them
 * @throws If model metadata conversion fails, such as for a non-string catalog name
 */
export async function discoverFreeModels(
  options: DiscoverFreeModelsOptions,
): Promise<FreeChatModelConfig[] | undefined> {
  if (!options.allowNetwork || options.signal.aborted) return undefined;

  const [liveIds, catalog] = await Promise.all([
    fetchLiveModelIds(options),
    fetchModelCatalog(options),
  ]);

  if (!liveIds || liveIds.length === 0 || !catalog) return undefined;

  const models = selectFreeModels(liveIds, freeCatalogModels(catalog));

  return models.length > 0 ? models : undefined;
}

/** Indexes bundled OpenAI-completions models with zero input and output costs by model id. */
function freeBuiltinModels(): Map<string, FreeChatModelConfig> {
  const models = new Map<string, FreeChatModelConfig>();

  for (const model of getBuiltinModels("opencode")) {
    if (model.api !== "openai-completions") continue;

    if (model.cost.input !== 0 || model.cost.output !== 0) continue;

    models.set(model.id, fromModel(model));
  }

  return models;
}

/** Overlays qualifying remote entries on bundled models; rejected or absent entries leave them intact. */
function freeCatalogModels(
  catalog: readonly RemoteCatalogEntry[],
): Map<string, FreeChatModelConfig> {
  const models = freeBuiltinModels();

  for (const entry of catalog) {
    const config = configFromRemote(entry);

    if (config) models.set(config.id, config);
  }

  return models;
}

/** Copies model capabilities into a provider configuration, omitting provider and endpoint identity. */
function fromModel(model: Model<Api>): FreeChatModelConfig {
  const config: FreeChatModelConfig = {
    id: model.id,
    name: model.name,
    input: model.input,
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    reasoning: model.reasoning,
  };

  if (model.thinkingLevelMap) config.thinkingLevelMap = model.thinkingLevelMap;

  if (model.compat) config.compat = model.compat;

  if (model.inputLimits) config.inputLimits = model.inputLimits;

  if (model.promptCache) config.promptCache = model.promptCache;

  return config;
}

/**
 * Converts a zero-input/output-cost OpenAI-completions chat entry with positive
 * finite limits, reasoning, and input metadata, or returns `undefined` when those checks fail.
 * Positive fractional token limits are rounded down; cache costs are preserved.
 *
 * @throws If an otherwise qualifying entry has a non-null name that is not a string
 */
function configFromRemote(entry: RemoteCatalogEntry): FreeChatModelConfig | undefined {
  if (entry.type !== undefined && entry.type !== "chat") return undefined;

  if (entry.api !== "openai-completions") return undefined;

  if (entry.cost?.input !== 0 || entry.cost.output !== 0) return undefined;

  if (!isPositiveInteger(entry.contextWindow)) return undefined;

  if (!isPositiveInteger(entry.maxTokens)) return undefined;

  if (entry.reasoning !== true && entry.reasoning !== false) return undefined;

  if (!entry.input || !isStringArray(entry.input)) return undefined;

  const config: FreeChatModelConfig = {
    id: entry.id,
    name: entry.name?.trim() || entry.id,
    input: entry.input.includes("image") ? ["text", "image"] : ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: entry.cost.cacheRead ?? 0,
      cacheWrite: entry.cost.cacheWrite ?? 0,
    },
    contextWindow: Math.floor(entry.contextWindow),
    maxTokens: Math.floor(entry.maxTokens),
    reasoning: entry.reasoning,
  };

  if (entry.thinkingLevelMap) config.thinkingLevelMap = entry.thinkingLevelMap;

  if (entry.compat) config.compat = entry.compat;

  if (entry.inputLimits) config.inputLimits = entry.inputLimits;

  if (entry.promptCache) config.promptCache = entry.promptCache;

  return config;
}

/** Selects live ids with known free metadata, preserving live order and duplicate ids. */
function selectFreeModels(
  liveIds: readonly string[],
  metadata: ReadonlyMap<string, FreeChatModelConfig>,
): FreeChatModelConfig[] {
  const models: FreeChatModelConfig[] = [];

  for (const id of liveIds) {
    const config = metadata.get(id);

    if (!config) continue;

    models.push(config);
  }

  return models;
}

/**
 * Fetches `/models` with the supplied headers and signal, omitting empty ids.
 * Returns `undefined` on HTTP, fetch, JSON parsing, or response-shape failure,
 * including an aborted fetch; a valid empty list returns an empty array.
 */
async function fetchLiveModelIds(
  options: DiscoverFreeModelsOptions,
): Promise<readonly string[] | undefined> {
  try {
    const response = await options.fetcher(`${options.baseUrl}/models`, {
      headers: { ...options.headers, Accept: "application/json" },
      signal: options.signal,
    });

    if (!response.ok) return undefined;

    const body: unknown = await response.json();

    if (!isLiveModelsResponse(body)) return undefined;

    const ids: string[] = [];

    for (const model of body.data ?? []) {
      if (model.id) ids.push(model.id);
    }

    return ids;
  } catch {
    return undefined;
  }
}

/**
 * Fetches Pi's OpenCode catalog with the supplied signal and without provider headers.
 * Returns an empty array when the bundled catalog is at least as recent, or
 * `undefined` on HTTP, fetch, JSON parsing, or response-shape failure, including abort.
 */
async function fetchModelCatalog(
  options: DiscoverFreeModelsOptions,
): Promise<readonly RemoteCatalogEntry[] | undefined> {
  try {
    const response = await options.fetcher(MODEL_CATALOG_URL, {
      headers: { Accept: "application/json" },
      signal: options.signal,
    });

    if (!response.ok) return undefined;

    const body: unknown = await response.json();

    if (!isRemoteCatalog(body)) return undefined;

    return isCatalogNewer(response.headers.get("last-modified")) ? body : [];
  } catch {
    return undefined;
  }
}

/**
 * Compares the remote Last-Modified date with the bundled catalog timestamp.
 * A missing or invalid remote date qualifies only when no bundled timestamp exists.
 */
function isCatalogNewer(lastModified: string | null): boolean {
  const remoteGeneratedAt = Date.parse(lastModified ?? "");
  const localGeneratedAt = getBuiltinModelDataGeneratedAt();

  if (Number.isNaN(remoteGeneratedAt)) return localGeneratedAt === undefined;

  return localGeneratedAt === undefined || remoteGeneratedAt > localGeneratedAt;
}

/** Requires a `data` array whose entries all have string ids; an empty array is valid. */
function isLiveModelsResponse(value: unknown): value is LiveModelsResponse {
  if (value === null || typeof value !== "object" || !("data" in value)) return false;

  const data = value.data;

  if (!Array.isArray(data)) return false;

  for (const model of data) {
    if (!isLiveModel(model)) return false;
  }

  return true;
}

/** Checks only for a string id, allowing empty ids and leaving other fields unchecked. */
function isLiveModel(value: unknown): value is LiveModel {
  if (value === null || typeof value !== "object" || !("id" in value)) return false;

  return typeof value.id === "string";
}

/** Accepts an empty catalog or entries with string ids; capability fields are not validated here. */
function isRemoteCatalog(value: unknown): value is readonly RemoteCatalogEntry[] {
  if (!Array.isArray(value)) return false;

  for (const model of value) {
    if (!isRemoteCatalogEntry(model)) return false;
  }

  return true;
}

/** Checks only for a string id, leaving optional catalog metadata unchecked. */
function isRemoteCatalogEntry(value: unknown): value is RemoteCatalogEntry {
  return (
    value !== null && typeof value === "object" && "id" in value && typeof value.id === "string"
  );
}

/** Accepts arrays containing only strings, including empty arrays. */
function isStringArray(value: unknown): value is readonly string[] {
  if (!Array.isArray(value)) return false;

  for (const item of value) {
    if (typeof item !== "string") return false;
  }

  return true;
}

/** Excludes NaN and infinities when validating numeric model limits. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Accepts finite values greater than zero, including fractions that callers round down. */
function isPositiveInteger(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}
