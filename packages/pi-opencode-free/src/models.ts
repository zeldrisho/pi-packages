import {
  isModelType,
  type AnyModel,
  type Api,
  type Model,
  type ModelsStoreEntry,
} from "@earendil-works/pi-ai";
import {
  getBuiltinModelDataGeneratedAt,
  getBuiltinModels,
} from "@earendil-works/pi-ai/providers/all";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

/** Default OpenAI-compatible OpenCode inference endpoint. */
export const DEFAULT_BASE_URL = "https://opencode.ai/inference/v1";

/** Pi's native OpenCode catalog overlay, as served by pi.dev. */
export const MODEL_CATALOG_URL = "https://pi.dev/api/models/providers/opencode?types=chat";

/** Chat model configuration accepted by `ProviderConfig.models`. */
export type FreeChatModelConfig = Extract<ProviderModelConfig, { reasoning: boolean }>;

/** Complete free metadata projection backing a pi.dev catalog validator. */
export interface ModelCatalogSnapshot {
  models: FreeChatModelConfig[];
  lastModified: number;
  etag?: string;
}

/** The visible live selection and the complete metadata backing conditional requests. */
export interface FreeModelsStoreEntry extends ModelsStoreEntry {
  catalog?: readonly FreeChatModelConfig[];
}

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

/** Machine-readable outcome of one live model discovery attempt. */
export type DiscoveryStatus =
  | "ok"
  | "offline"
  | "aborted"
  | "timeout"
  | "live-request-failed"
  | "live-response-invalid"
  | "live-empty"
  | "catalog-request-failed"
  | "catalog-response-invalid"
  | "no-known-free-models";

/** Discovery result with a failure reason that callers can report without exposing payloads. */
export interface DiscoveryOutcome {
  status: DiscoveryStatus;
  models?: FreeChatModelConfig[];
  catalog?: ModelCatalogSnapshot;
  /** Present only for HTTP failures, not transport or response-shape failures. */
  httpStatus?: number;
  /** Number of ids reported by the live endpoint, when it responded successfully. */
  liveModelCount?: number;
}

/** Inputs for live free-model discovery. */
export interface DiscoverFreeModelsOptions {
  baseUrl: string;
  headers: Record<string, string>;
  signal: AbortSignal;
  fetcher: typeof fetch;
  allowNetwork: boolean;
  catalog?: ModelCatalogSnapshot;
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
 * Restores cached free-model metadata, accepting an empty catalog and lastModified of zero.
 * Returns undefined if the catalog or timestamp is missing or invalid, or any entry is unusable.
 */
export function catalogFromStoredEntry(
  stored: Readonly<ModelsStoreEntry> | undefined,
): ModelCatalogSnapshot | undefined {
  const lastModified = stored?.lastModified;

  if (
    !stored ||
    lastModified === undefined ||
    !Number.isFinite(lastModified) ||
    lastModified < 0 ||
    !("catalog" in stored) ||
    !Array.isArray(stored.catalog)
  ) {
    return undefined;
  }

  const models: FreeChatModelConfig[] = [];

  for (const entry of stored.catalog) {
    if (!isRemoteCatalogEntry(entry)) return undefined;

    const config = configFromRemote({ ...entry, api: "openai-completions" });

    if (!config) return undefined;

    models.push(config);
  }

  return {
    models,
    lastModified,
    etag: stored.etag,
  };
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
 * Discovers free chat models and reports why discovery failed.
 *
 * The live endpoint decides which models currently exist. Pi's OpenCode
 * catalog supplies their capabilities and compatibility flags. A newer remote
 * catalog overlays bundled metadata; otherwise bundled metadata is used.
 * A catalog 304 reuses a nonempty cached body with an ETag; 404/501 uses bundled metadata.
 * HTTP, transport, parsing, and cancellation failures are returned as statuses
 * without exposing response bodies, headers, or credentials.
 *
 * @param options - Endpoint, headers, abort signal, fetcher, network permission,
 *   and optional cached metadata for revalidation
 * @returns Discovered models and the complete metadata snapshot, or a bounded
 *   failure status with an HTTP status when an HTTP request failed
 */
export async function discoverFreeModelsWithStatus(
  options: DiscoverFreeModelsOptions,
): Promise<DiscoveryOutcome> {
  if (!options.allowNetwork) return { status: "offline" };

  if (options.signal.aborted) return { status: "aborted" };

  const [live, catalog] = await Promise.all([
    fetchLiveModelIds(options),
    fetchModelCatalog(options),
  ]);

  if (options.signal.aborted) {
    return { status: options.signal.reason?.name === "TimeoutError" ? "timeout" : "aborted" };
  }

  if (!live.ok) return { status: live.failure, httpStatus: live.httpStatus };

  if (!catalog.ok) return { status: catalog.failure, httpStatus: catalog.httpStatus };

  if (live.ids.length === 0) return { status: "live-empty", liveModelCount: 0 };

  const metadata = isCatalogNewer(catalog.snapshot.lastModified) ? catalog.snapshot.models : [];
  const models = selectFreeModels(live.ids, freeCatalogModels(metadata));

  return models.length > 0
    ? { status: "ok", models, catalog: catalog.snapshot, liveModelCount: live.ids.length }
    : { status: "no-known-free-models", liveModelCount: live.ids.length };
}

/**
 * Discovers free chat models from the live endpoint and Pi's native catalog.
 *
 * @param options - Endpoint, headers, abort signal, and fetcher
 * @returns Free chat model configurations, or `undefined` when discovery cannot verify them
 */
export async function discoverFreeModels(
  options: DiscoverFreeModelsOptions,
): Promise<FreeChatModelConfig[] | undefined> {
  return (await discoverFreeModelsWithStatus(options)).models;
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

/** Overlays already validated free metadata on bundled models, replacing matching ids. */
function freeCatalogModels(
  catalog: readonly FreeChatModelConfig[],
): Map<string, FreeChatModelConfig> {
  const models = freeBuiltinModels();

  for (const config of catalog) models.set(config.id, config);

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
 * Converts a zero-input/output-cost OpenAI-completions chat entry with finite
 * token limits of at least one, reasoning, and input metadata, or returns
 * `undefined` when those checks fail. Fractional token limits are rounded down;
 * supplied cache costs must be finite and nonnegative and are preserved.
 */
function configFromRemote(entry: RemoteCatalogEntry): FreeChatModelConfig | undefined {
  if (entry.type !== undefined && entry.type !== "chat") return undefined;

  if (entry.api !== "openai-completions") return undefined;

  if (entry.cost?.input !== 0 || entry.cost.output !== 0) return undefined;

  if (!isPositiveInteger(entry.contextWindow)) return undefined;

  if (!isPositiveInteger(entry.maxTokens)) return undefined;

  if (entry.cost.cacheRead !== undefined && !isNonNegativeNumber(entry.cost.cacheRead))
    return undefined;

  if (entry.cost.cacheWrite !== undefined && !isNonNegativeNumber(entry.cost.cacheWrite))
    return undefined;

  if (entry.reasoning !== true && entry.reasoning !== false) return undefined;

  if (!entry.input || !isStringArray(entry.input)) return undefined;

  const name = entry.name?.trim() || entry.id;

  const config: FreeChatModelConfig = {
    id: entry.id,
    name,
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
 * Returns a classified failure on HTTP, fetch, JSON parsing, or response-shape
 * failure, including an aborted fetch; a valid empty list succeeds.
 * HTTP failures include the response status; caught errors do not propagate.
 */
async function fetchLiveModelIds(
  options: DiscoverFreeModelsOptions,
): Promise<
  | { ok: true; ids: readonly string[] }
  | { ok: false; failure: DiscoveryStatus; httpStatus?: number }
> {
  try {
    const response = await options.fetcher(`${options.baseUrl}/models`, {
      headers: { ...options.headers, Accept: "application/json" },
      signal: options.signal,
    });

    if (!response.ok)
      return { ok: false, failure: "live-request-failed", httpStatus: response.status };

    const body: unknown = await response.json().catch(() => undefined);

    if (!isLiveModelsResponse(body)) return { ok: false, failure: "live-response-invalid" };

    const ids: string[] = [];

    for (const model of body.data ?? []) {
      if (model.id) ids.push(model.id);
    }

    return { ok: true, ids };
  } catch {
    return { ok: false, failure: "live-request-failed" };
  }
}

/**
 * Fetches Pi's OpenCode catalog with the supplied signal and without provider headers.
 * Revalidates nonempty cached metadata with ETag, retaining it on 304.
 * Missing catalogs (404/501) produce the native empty overlay marker. Other HTTP,
 * fetch, JSON parsing, or response-shape failures are classified.
 * Invalid ids or names discard individual entries; a nonempty response with no
 * valid entries is a response-shape failure.
 * Successful snapshots contain free-model metadata, an optional ETag, and a
 * Last-Modified time in epoch milliseconds (zero when missing or invalid).
 */
async function fetchModelCatalog(
  options: DiscoverFreeModelsOptions,
): Promise<
  | { ok: true; snapshot: ModelCatalogSnapshot }
  | { ok: false; failure: DiscoveryStatus; httpStatus?: number }
> {
  try {
    const cached = options.catalog;
    const validator = cached && cached.models.length > 0 ? cached.etag : undefined;
    const headers = new Headers({ Accept: "application/json" });

    if (validator) headers.set("If-None-Match", validator);

    const response = await options.fetcher(MODEL_CATALOG_URL, {
      headers,
      signal: options.signal,
    });

    if (response.status === 304 && validator && cached) return { ok: true, snapshot: cached };

    if (response.status === 404 || response.status === 501)
      return { ok: true, snapshot: { models: [], lastModified: 0 } };

    if (!response.ok)
      return { ok: false, failure: "catalog-request-failed", httpStatus: response.status };

    const body: unknown = await response.json().catch(() => undefined);

    if (!Array.isArray(body)) return { ok: false, failure: "catalog-response-invalid" };

    const entries = body.filter(isRemoteCatalogEntry);

    if (body.length > 0 && entries.length === 0)
      return { ok: false, failure: "catalog-response-invalid" };

    const models: FreeChatModelConfig[] = [];

    for (const entry of entries) {
      const config = configFromRemote(entry);

      if (config) models.push(config);
    }

    const lastModified = Date.parse(response.headers.get("last-modified") ?? "");

    return {
      ok: true,
      snapshot: {
        models,
        lastModified: Number.isNaN(lastModified) ? 0 : lastModified,
        etag: response.headers.get("etag") ?? undefined,
      },
    };
  } catch {
    return { ok: false, failure: "catalog-request-failed" };
  }
}

/**
 * Returns whether the remote Last-Modified time in epoch milliseconds is strictly
 * newer than the bundled timestamp; any value qualifies if no bundled timestamp exists.
 */
function isCatalogNewer(lastModified: number): boolean {
  const localGeneratedAt = getBuiltinModelDataGeneratedAt();

  return localGeneratedAt === undefined || lastModified > localGeneratedAt;
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

/** Validates identity and display name before an entry enters capability conversion. */
function isRemoteCatalogEntry(value: unknown): value is RemoteCatalogEntry {
  if (value === null || typeof value !== "object" || !("id" in value)) return false;

  if (typeof value.id !== "string" || !value.id.trim()) return false;

  return !("name" in value) || value.name == null || typeof value.name === "string";
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

/** Cache pricing must be finite and non-negative. */
function isNonNegativeNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

/** Accepts finite limits that remain positive after rounding down. */
function isPositiveInteger(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 1;
}
