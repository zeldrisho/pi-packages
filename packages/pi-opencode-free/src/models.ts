import { isModelType, type AnyModel, type Api, type Model } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

/** Default OpenAI-compatible OpenCode inference endpoint. */
export const DEFAULT_BASE_URL = "https://opencode.ai/inference/v1";

/** Public models catalog used to confirm which live models are free. */
export const MODELS_DEV_URL = "https://models.dev/api.json";

const DEFAULT_PUBLIC_API_KEY = "public";

/** Chat model configuration accepted by `ProviderConfig.models`. */
export type FreeChatModelConfig = Extract<ProviderModelConfig, { reasoning: boolean }>;

const DEFAULT_CONTEXT_WINDOW = 128_000;

const DEFAULT_MAX_TOKENS = 16_384;

const ZERO_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
} as const;

const OPENCODE_COMPAT: NonNullable<FreeChatModelConfig["compat"]> = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsStrictMode: true,
  maxTokensField: "max_tokens",
};

const DEEPSEEK_COMPAT: NonNullable<FreeChatModelConfig["compat"]> = {
  ...OPENCODE_COMPAT,
  requiresReasoningContentOnAssistantMessages: true,
};

const REASONING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

const EFFORT_LEVEL_NAMES = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);

interface ModelsDevReasoningOption {
  type?: string;
  values?: readonly string[];
}

interface ModelsDevModel {
  id?: string;
  name?: string;
  reasoning?: boolean;
  reasoning_options?: readonly ModelsDevReasoningOption[];
  tool_call?: boolean;
  interleaved?: {
    field?: string;
  };
  modalities?: {
    input?: readonly string[];
    output?: readonly string[];
  };
  limit?: {
    context?: number;
    output?: number;
  };
  cost?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
  };
  provider?: {
    api?: string;
  };
}

interface ModelsDevProvider {
  models?: Record<string, ModelsDevModel>;
}

interface ModelsDevCatalog {
  opencode?: ModelsDevProvider;
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
 * Resolves the provider base URL, allowing a local proxy or alternate gateway.
 *
 * @param environment - Environment variables visible to the extension
 * @returns The configured URL without trailing slashes, or the OpenCode default
 */
export function resolveBaseUrl(environment: Record<string, string | undefined>): string {
  const configured = environment.OPENCODE_FREE_BASE_URL?.trim();

  if (!configured) return DEFAULT_BASE_URL;

  return configured.replace(/\/+$/u, "");
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
 * Restores cached free models from Pi's persisted model store.
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
 * Discovers free chat models from the live endpoint and models.dev.
 *
 * @param options - Endpoint, headers, abort signal, and fetcher
 * @returns Free chat model configurations, or `undefined` when discovery cannot verify them
 */
export async function discoverFreeModels(
  options: DiscoverFreeModelsOptions,
): Promise<FreeChatModelConfig[] | undefined> {
  if (!options.allowNetwork || options.signal.aborted) return undefined;

  const [liveIds, catalog] = await Promise.all([
    fetchLiveModelIds(options),
    fetchModelsDevCatalog(options),
  ]);

  if (!liveIds || liveIds.length === 0 || !catalog) return undefined;

  const models = selectFreeModels(liveIds, freeMetadataById(catalog));

  return models.length > 0 ? models : undefined;
}

function freeBuiltinModels(): Map<string, FreeChatModelConfig> {
  const models = new Map<string, FreeChatModelConfig>();

  for (const model of getBuiltinModels("opencode")) {
    if (model.api !== "openai-completions") continue;

    if (model.cost.input !== 0 || model.cost.output !== 0) continue;

    models.set(model.id, fromModel(model));
  }

  return models;
}

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

function selectFreeModels(
  liveIds: readonly string[],
  metadata: ReadonlyMap<string, ModelsDevModel>,
): FreeChatModelConfig[] {
  const builtIn = freeBuiltinModels();
  const models: FreeChatModelConfig[] = [];

  for (const id of liveIds) {
    const entry = metadata.get(id);

    if (!entry) continue;

    models.push(builtIn.get(id) ?? modelFromMetadata(id, entry));
  }

  return models;
}

function freeMetadataById(catalog: ModelsDevCatalog): Map<string, ModelsDevModel> {
  const models = new Map<string, ModelsDevModel>();
  const catalogModels = catalog.opencode?.models;

  if (!catalogModels) return models;

  for (const [key, entry] of Object.entries(catalogModels)) {
    if (!isFreeChatMetadata(entry)) continue;

    models.set(entry.id ?? key, entry);
  }

  return models;
}

function isFreeChatMetadata(entry: ModelsDevModel): boolean {
  if (entry.cost?.input !== 0 || entry.cost?.output !== 0) return false;

  if (entry.tool_call === false) return false;

  const providerApi = entry.provider?.api;

  if (providerApi && !providerApi.includes("openai")) return false;

  const outputModalities = entry.modalities?.output;

  return !outputModalities || outputModalities.includes("text");
}

function modelFromMetadata(id: string, metadata: ModelsDevModel): FreeChatModelConfig {
  const contextWindow = positiveInteger(metadata.limit?.context) ?? DEFAULT_CONTEXT_WINDOW;

  const config: FreeChatModelConfig = {
    id,
    name: metadata.name?.trim() || id,
    input: metadata.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
    cost: ZERO_COST,
    contextWindow,
    maxTokens:
      positiveInteger(metadata.limit?.output) ?? Math.min(DEFAULT_MAX_TOKENS, contextWindow),
    reasoning: metadata.reasoning === true,
    compat: OPENCODE_COMPAT,
  };

  const thinkingLevelMap = thinkingMapFromOptions(metadata.reasoning_options);

  if (thinkingLevelMap) config.thinkingLevelMap = thinkingLevelMap;

  if (metadata.interleaved?.field === "reasoning_content" && id.includes("deepseek")) {
    config.compat = DEEPSEEK_COMPAT;
  }

  return config;
}

function positiveInteger(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;

  return Math.floor(value);
}

function thinkingMapFromOptions(
  options: readonly ModelsDevReasoningOption[] | undefined,
): FreeChatModelConfig["thinkingLevelMap"] | undefined {
  if (!options) return undefined;

  for (const option of options) {
    if (option.type !== "effort" || !option.values) continue;

    return effortThinkingMap(option.values);
  }

  return undefined;
}

function effortThinkingMap(
  values: readonly string[],
): NonNullable<FreeChatModelConfig["thinkingLevelMap"]> {
  const supported = new Set(values);

  const map: NonNullable<FreeChatModelConfig["thinkingLevelMap"]> = {
    off: supported.has("none") ? "none" : null,
    minimal: supported.has("minimal") ? "minimal" : null,
  };

  for (const level of REASONING_LEVELS) {
    map[level] = supported.has(level) && EFFORT_LEVEL_NAMES.has(level) ? level : null;
  }

  return map;
}

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

async function fetchModelsDevCatalog(
  options: DiscoverFreeModelsOptions,
): Promise<ModelsDevCatalog | undefined> {
  try {
    const response = await options.fetcher(MODELS_DEV_URL, {
      headers: { Accept: "application/json" },
      signal: options.signal,
    });

    if (!response.ok) return undefined;

    const body: unknown = await response.json();

    return isModelsDevCatalog(body) ? body : undefined;
  } catch {
    return undefined;
  }
}

function isLiveModelsResponse(value: unknown): value is LiveModelsResponse {
  if (value === null || typeof value !== "object" || !("data" in value)) return false;

  const data = value.data;

  if (!Array.isArray(data)) return false;

  for (const model of data) {
    if (!isLiveModel(model)) return false;
  }

  return true;
}

function isLiveModel(value: unknown): value is LiveModel {
  if (value === null || typeof value !== "object" || !("id" in value)) return false;

  return typeof value.id === "string";
}

function isModelsDevCatalog(value: unknown): value is ModelsDevCatalog {
  if (value === null || typeof value !== "object" || !("opencode" in value)) return false;

  return isModelsDevProvider(value.opencode);
}

function isModelsDevProvider(value: unknown): value is ModelsDevProvider {
  if (value === null || typeof value !== "object" || !("models" in value)) return false;

  const models = value.models;

  if (models === null || typeof models !== "object" || Array.isArray(models)) return false;

  for (const entry of Object.values(models)) {
    if (!isModelsDevModel(entry)) return false;
  }

  return true;
}

function isModelsDevModel(value: unknown): value is ModelsDevModel {
  return value !== null && typeof value === "object";
}
