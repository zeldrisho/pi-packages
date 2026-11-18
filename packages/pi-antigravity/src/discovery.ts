import {
  isModelType,
  type AnyModel,
  type JsonObject,
  type JsonValue,
  type ModelThinkingLevel,
  type ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import { isJsonNumber, isJsonObject, nonEmptyText } from "./json.ts";
import {
  ANTIGRAVITY_API,
  type AntigravityModel,
  FALLBACK_MODELS,
  type AntigravityModelConfig,
} from "./models.ts";
import { ENDPOINTS, antigravityHeaders } from "./project.ts";
import { builtinGeminiMetadata, type GeminiMetadata } from "./pi-catalog.ts";

/** Metadata lookups fail fast so the caller can fall back to a cached catalog. */
const DISCOVERY_TIMEOUT_MS = 8_000;

/** Thinking-level suffixes the backend appends to runtime model ids. */
const THINKING_SUFFIXES: readonly [suffix: string, level: ModelThinkingLevel][] = [
  ["extra-low", "minimal"],
  ["minimal", "minimal"],
  ["extra-high", "xhigh"],
  ["xhigh", "xhigh"],
  ["thinking", "high"],
  ["high", "high"],
  ["medium", "medium"],
  ["low", "low"],
];

/** Display-name parentheticals the backend uses for thinking levels. */
const DISPLAY_LEVELS: readonly [pattern: RegExp, level: ModelThinkingLevel][] = [
  [/^extra\s*low$/i, "minimal"],
  [/^minimal$/i, "minimal"],
  [/^extra\s*high$/i, "xhigh"],
  [/^xhigh$/i, "xhigh"],
  [/^thinking$/i, "high"],
  [/^high$/i, "high"],
  [/^medium$/i, "medium"],
  [/^low$/i, "low"],
];

/** Answers collected for one public model while grouping runtime variants. */
interface VariantGroup {
  publicId: string;
  names: string[];
  levels: ThinkingLevelMap;
  unsuffixed?: string;
  contextWindow?: number;
  maxTokens?: number;
  supportsThinking?: boolean;
  supportsImages?: boolean;
  budgetRoutes?: Set<string>;
}

/**
 * Reads the model id's thinking-level suffix.
 *
 * @param runtimeId - Runtime model id from the backend
 * @returns The public id and level, or undefined when the id carries no level
 */
function parseThinkingSuffix(
  runtimeId: string,
): { publicId: string; level: ModelThinkingLevel } | undefined {
  for (const [suffix, level] of THINKING_SUFFIXES) {
    if (!runtimeId.endsWith(`-${suffix}`)) continue;

    const publicId = runtimeId.slice(0, -(suffix.length + 1));

    if (publicId !== "") return { publicId, level };
  }

  return undefined;
}

/**
 * Reads the thinking level from a display name such as `Gemini 3.8 Flash (High)`.
 *
 * @param displayName - Display name reported by the backend
 * @returns The level, or undefined when the name carries none
 */
function levelFromDisplayName(displayName: string | undefined): ModelThinkingLevel | undefined {
  const parenthetical = displayName?.match(/\(([^)]+)\)\s*$/)?.[1]?.trim();

  if (parenthetical === undefined) return undefined;

  for (const [pattern, level] of DISPLAY_LEVELS) {
    if (pattern.test(parenthetical)) return level;
  }

  return undefined;
}

/**
 * Removes a trailing level parenthetical from a display name.
 *
 * @param displayName - Display name reported by the backend
 * @returns The name without the level, or undefined when nothing remains
 */
function baseDisplayName(displayName: string | undefined): string | undefined {
  const trimmed = displayName?.trim();

  if (trimmed === undefined || trimmed === "") return undefined;

  const stripped = trimmed.replace(/\s*\([^)]*\)\s*$/, "").trim();

  return stripped === "" ? trimmed : stripped;
}

/**
 * Reads the display name of one runtime model.
 *
 * @param info - Model metadata object from the backend
 * @returns The display name, or undefined when the payload carries none
 */
function displayNameOf(info: JsonValue | undefined): string | undefined {
  if (!isJsonObject(info)) return undefined;

  return (
    nonEmptyText(info.displayName) ?? nonEmptyText(info.modelDisplayName) ?? nonEmptyText(info.name)
  );
}

/**
 * Reports whether the backend marks a runtime model as selectable.
 *
 * @param runtimeId - Runtime model id
 * @param info - Model metadata object from the backend
 * @returns True when the model is a chat model an account can select
 */
function isSelectable(runtimeId: string, info: JsonValue | undefined): boolean {
  if (!/^[a-z0-9][a-z0-9_.-]*$/i.test(runtimeId)) return false;

  if (/^MODEL_/i.test(runtimeId) || /^(chat_|tab_)/i.test(runtimeId)) return false;

  if (runtimeId.endsWith("-disabled")) return false;

  if (!isJsonObject(info)) return true;

  if (info.isInternal === true || info.disabled === true) return false;

  if (info.apiProvider === "API_PROVIDER_INTERNAL") return false;

  const name = displayNameOf(info);

  if (/image/i.test(runtimeId)) return false;

  if (name !== undefined && /image/i.test(name)) return false;

  return true;
}

/**
 * Reads the runtime ids the backend recommends for its agent model picker.
 *
 * @param sorts - `agentModelSorts` value from the backend
 * @returns Recommended runtime ids, or undefined when the payload lists none
 */
export function recommendedRuntimeIds(sorts: JsonValue | undefined): Set<string> | undefined {
  if (!Array.isArray(sorts)) return undefined;

  const ids = new Set<string>();

  for (const sort of sorts) {
    if (!isJsonObject(sort) || !Array.isArray(sort.groups)) continue;

    for (const group of sort.groups) {
      if (!isJsonObject(group) || !Array.isArray(group.modelIds)) continue;

      for (const id of group.modelIds) {
        const runtimeId = nonEmptyText(id);

        if (runtimeId !== undefined) ids.add(runtimeId);
      }
    }
  }

  return ids.size === 0 ? undefined : ids;
}

/**
 * Collects runtime variants into public models, applying recommended filtering.
 *
 * @param models - Runtime model metadata keyed by runtime id
 * @param recommended - Runtime ids the backend recommends, when it lists any
 * @returns One group per public model id
 */
function groupVariants(
  models: JsonObject,
  recommended: Set<string> | undefined,
): Map<string, VariantGroup> {
  const groups = new Map<string, VariantGroup>();

  for (const [runtimeId, info] of Object.entries(models)) {
    if (!isSelectable(runtimeId, info)) continue;

    if (recommended !== undefined && !recommended.has(runtimeId)) continue;

    const infoObject = isJsonObject(info) ? info : undefined;
    const displayName = displayNameOf(infoObject);

    const trimmedId = runtimeId.endsWith("-tiered")
      ? runtimeId.slice(0, -"-tiered".length)
      : runtimeId;

    const suffix = parseThinkingSuffix(trimmedId);
    const publicId = suffix?.publicId ?? trimmedId;
    const group = groups.get(publicId) ?? { publicId, names: [], levels: {} };

    groups.set(publicId, group);

    if (displayName !== undefined) {
      const base = baseDisplayName(displayName);

      if (base !== undefined && !group.names.includes(base)) group.names.push(base);
    }

    if (
      infoObject?.supportsThinking === true &&
      infoObject.thinkingLevel === undefined &&
      positiveLimit(infoObject.thinkingBudget) !== undefined
    ) {
      (group.budgetRoutes ??= new Set()).add(runtimeId);
    }

    const level = levelFromDisplayName(displayName) ?? suffix?.level;

    if (level !== undefined) group.levels[level] = runtimeId;
    else if (group.unsuffixed === undefined) group.unsuffixed = runtimeId;

    absorbLimits(group, infoObject);
  }

  return groups;
}

/**
 * Merges the limits one runtime variant advertises into its group.
 *
 * A public model can route to any variant, so the group advertises the
 * smallest supplied limit; every route then stays within what the backend allows.
 *
 * @param group - Group being built
 * @param info - Model metadata object from the backend
 */
function absorbLimits(group: VariantGroup, info: JsonValue | undefined): void {
  if (!isJsonObject(info)) return;

  const contextWindow = positiveLimit(info.maxTokens);
  const maxTokens = positiveLimit(info.maxOutputTokens);

  if (contextWindow !== undefined) {
    group.contextWindow = Math.min(group.contextWindow ?? contextWindow, contextWindow);
  }

  if (maxTokens !== undefined) {
    group.maxTokens = Math.min(group.maxTokens ?? maxTokens, maxTokens);
  }

  if (info.supportsThinking === true) group.supportsThinking = true;
  else if (info.supportsThinking === false && group.supportsThinking !== true) {
    group.supportsThinking = false;
  }

  if (info.supportsImages === false) group.supportsImages = false;
  else if (info.supportsImages === true && group.supportsImages !== true) {
    group.supportsImages = true;
  }
}

/**
 * Reads a positive integer limit from backend metadata.
 *
 * @param value - Candidate limit
 * @returns The limit, or undefined when it is not a positive integer
 */
function positiveLimit(value: JsonValue | undefined): number | undefined {
  return isJsonNumber(value) && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Limits assumed when neither the backend nor the seed catalog supplies one. */
const ASSUMED_CONTEXT_WINDOW = 128_000;

const ASSUMED_MAX_TOKENS = 32_768;

/**
 * Builds one catalog entry from a group of runtime variants.
 *
 * @param group - Grouped runtime variants
 * @param seed - Fallback entries consulted for limits and naming
 * @returns The catalog entry
 */
function entryFromGroup(
  group: VariantGroup,
  seed: readonly AntigravityModel[],
  geminiMetadata: ReadonlyMap<string, GeminiMetadata>,
): AntigravityModel | undefined {
  const known = seed.find((model) => model.id === group.publicId);

  const native = geminiMetadata.get(group.publicId);

  const levels = new Map<ModelThinkingLevel, string>();

  for (const [level, runtimeId] of Object.entries(group.levels)) {
    if (runtimeId === null || runtimeId === undefined) continue;

    // SAFETY: group levels are only ever set from the typed level tables above.
    levels.set(level as ModelThinkingLevel, runtimeId);
  }

  const single = group.unsuffixed;

  if (single !== undefined && levels.size === 0) {
    for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
      levels.set(level, single);
    }
  } else if (single !== undefined) {
    levels.set("off", single);
  }

  if (levels.size === 0) return undefined;

  // One budget-based runtime can accept Pi's token-budget settings. Do not
  // collapse distinct runtime variants or infer support from the model name.
  const routes = new Set(levels.values());
  const runtimeId = routes.size === 1 ? [...routes][0] : undefined;

  if (runtimeId !== undefined && group.budgetRoutes?.has(runtimeId) === true) {
    for (const level of ["minimal", "low", "medium", "high"] as const) levels.set(level, runtimeId);
    levels.delete("xhigh");
    levels.delete("max");
  }

  // Native Google metadata restricts Gemini levels, but never supplies a route
  // the Antigravity account did not advertise.
  if (native !== undefined) {
    const supported = new Set(native.levels);

    for (const level of levels.keys()) if (!supported.has(level)) levels.delete(level);

    if (levels.size === 0) return undefined;
  }

  // Pi treats undefined levels as supported. Explicit nulls prevent it from
  // offering effort levels for which the backend supplied no runtime variant.
  const thinkingLevelMap: ThinkingLevelMap = {
    off: null,
    minimal: null,
    low: null,
    medium: null,
    high: null,
    xhigh: null,
    max: null,
  };

  for (const [level, runtimeId] of levels) thinkingLevelMap[level] = runtimeId;

  const inputs: ("text" | "image")[] =
    group.supportsImages === false || (native !== undefined && !native.input.includes("image"))
      ? ["text"]
      : (known?.input ?? ["text", "image"]);

  return {
    id: group.publicId,
    name: group.names[0] ?? known?.name ?? group.publicId,
    reasoning: group.supportsThinking !== false,
    input: inputs,
    contextWindow: Math.min(
      group.contextWindow ?? known?.contextWindow ?? ASSUMED_CONTEXT_WINDOW,
      native?.contextWindow ?? Infinity,
    ),
    maxTokens: Math.min(
      group.maxTokens ?? known?.maxTokens ?? ASSUMED_MAX_TOKENS,
      native?.maxTokens ?? Infinity,
    ),
    thinkingLevelMap,
  };
}

/**
 * Builds the catalog from a `fetchAvailableModels` response body.
 *
 * @param body - Parsed response body
 * @param seed - Fallback entries consulted when the payload omits metadata
 * @returns Catalog entries, or undefined when the payload lists no usable model
 */
export function catalogFromAvailableModels(
  body: JsonValue | undefined,
  seed: readonly AntigravityModel[] = FALLBACK_MODELS,
  geminiMetadata: ReadonlyMap<string, GeminiMetadata> = builtinGeminiMetadata(),
): AntigravityModel[] | undefined {
  if (!isJsonObject(body) || !isJsonObject(body.models)) return undefined;

  const declared = body.models;
  const recommended = recommendedRuntimeIds(body.agentModelSorts);

  const entries = (filtered: Set<string> | undefined): AntigravityModel[] => {
    const models: AntigravityModel[] = [];

    for (const group of groupVariants(declared, filtered).values()) {
      const entry = entryFromGroup(group, seed, geminiMetadata);

      if (entry !== undefined) models.push(entry);
    }

    return models;
  };

  const selected = entries(recommended);

  return selected.length === 0 ? undefined : selected;
}

/**
 * Requests the model catalog for an account.
 *
 * @param token - OAuth access token
 * @param projectId - Project the account is billed against
 * @param signal - Caller cancellation, extended with a discovery deadline
 * @returns The parsed body from the first endpoint that answers, or undefined
 */
export async function fetchAvailableModels(
  token: string,
  projectId: string,
  signal: AbortSignal | undefined,
): Promise<JsonValue | undefined> {
  const deadline = AbortSignal.any([
    ...(signal === undefined ? [] : [signal]),
    AbortSignal.timeout(DISCOVERY_TIMEOUT_MS * ENDPOINTS.length),
  ]);

  const headers = await antigravityHeaders(token, signal);

  for (const endpoint of ENDPOINTS) {
    try {
      const response = await fetch(`${endpoint}/v1internal:fetchAvailableModels`, {
        method: "POST",
        headers,
        body: JSON.stringify({ project: projectId }),
        signal: deadline,
      });

      if (!response.ok) continue;

      return await response.json();
    } catch (error) {
      if (signal?.aborted === true) throw error;
    }
  }

  return undefined;
}

/**
 * Restores a stored catalog from Pi's persisted model store.
 *
 * @param stored - Models from `RefreshModelsContext.stored`
 * @param providerId - Provider id that owns the catalog
 * @returns Catalog entries this provider owns, or undefined when none are usable
 */
export function modelsFromStored(
  stored: readonly AnyModel[] | undefined,
  providerId: string,
): AntigravityModel[] | undefined {
  const models: AntigravityModel[] = [];

  for (const model of stored ?? []) {
    if (!isModelType(model, "chat")) continue;

    if (model.provider !== providerId) continue;

    if (model.api !== ANTIGRAVITY_API) continue;

    models.push({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: model.input,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      thinkingLevelMap: model.thinkingLevelMap ?? {},
    });
  }

  return models.length === 0 ? undefined : models;
}

/**
 * Projects catalog entries into the full models Pi persists.
 *
 * @param models - Catalog entries to persist
 * @param providerId - Provider id that owns the catalog
 * @param baseUrl - Current provider base URL
 * @returns Models suitable for `ModelsStoreEntry.models`
 */
export function storedModelsFrom(
  models: readonly AntigravityModelConfig[],
  providerId: string,
  baseUrl: string,
) {
  return models.map((config) => ({
    id: config.id,
    name: config.name,
    provider: providerId,
    api: ANTIGRAVITY_API,
    baseUrl,
    input: config.input,
    cost: config.cost,
    contextWindow: config.contextWindow,
    maxTokens: config.maxTokens,
    reasoning: config.reasoning,
    thinkingLevelMap: config.thinkingLevelMap,
  }));
}

/**
 * Refreshes the catalog from the backend, falling back to cached or seed models.
 *
 * Discovery is best-effort: a failed lookup keeps the previous catalog so an
 * offline start, a rate-limited account, or a rejected token never empties the
 * model list.
 *
 * @param options - Refresh inputs
 * @returns Catalog entries to register with Pi
 */
export async function resolveCatalog(options: {
  apiKey: { token: string; projectId: string } | undefined;
  stored: readonly AnyModel[] | undefined;
  providerId: string;
  allowNetwork: boolean;
  signal: AbortSignal | undefined;
}): Promise<AntigravityModel[]> {
  const stored = modelsFromStored(options.stored, options.providerId);

  if (!options.allowNetwork || options.signal?.aborted === true || options.apiKey === undefined) {
    return stored ?? [...FALLBACK_MODELS];
  }

  const body = await fetchAvailableModels(
    options.apiKey.token,
    options.apiKey.projectId,
    options.signal,
  );

  const discovered = catalogFromAvailableModels(body);

  return discovered ?? stored ?? [...FALLBACK_MODELS];
}
