import type { ModelThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

/** Provider id used by `/model`, `/login`, and stored credentials. */
export const PROVIDER_ID = "antigravity";

/** Display name shown in Pi's login and model lists. */
export const PROVIDER_NAME = "Antigravity";

/**
 * API id for this provider's wire protocol. Pi dispatches it to the
 * `streamSimple` handler registered with the provider.
 */
export const ANTIGRAVITY_API = "antigravity";

/** Thinking configuration requested from the backend for one call. */
export type ThinkingConfig =
  | { includeThoughts: boolean; thinkingBudget: number }
  | { includeThoughts: boolean; thinkingLevel: "LOW" | "MEDIUM" | "HIGH" };

/**
 * One selectable model: the public id Pi shows, the runtime request ids the
 * backend expects per thinking level, and the limits the backend advertises.
 *
 * Discovery builds these from `fetchAvailableModels`; the fallback seed below
 * uses the same shape so both paths share one request implementation.
 */
export interface AntigravityModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap: ThinkingLevelMap;
}

/**
 * No static model list is maintained. Antigravity's account catalog is the
 * source of truth and is refreshed through the provider API.
 */
export const FALLBACK_MODELS: readonly AntigravityModel[] = [];

/** Zeroed rates: access is quota-backed by the account, so Pi never bills these models. */
const SUBSCRIPTION_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** The routing Pi exposes for a model: its id plus per-level runtime ids. */
export interface RoutableModel {
  id: string;
  thinkingLevelMap?: ThinkingLevelMap;
}

/**
 * Resolves the backend request id for a thinking level.
 *
 * @param model - Registered model, from the catalog or from discovery
 * @param level - Pi thinking level for this request
 * @returns The runtime model id the backend expects
 */
export function resolveRuntimeModel(model: RoutableModel, level?: ModelThinkingLevel): string {
  const map = model.thinkingLevelMap ?? {};

  if (level !== undefined) {
    const mapped = map[level];

    if (mapped !== undefined && mapped !== null) return mapped;
  }

  const fallback =
    map.medium ?? map.high ?? map.low ?? map.off ?? map.minimal ?? map.xhigh ?? map.max;

  if (fallback !== undefined && fallback !== null) return fallback;

  if (Object.keys(map).length === 0) return model.id;
  throw new Error(`No advertised Antigravity runtime route for ${model.id}`);
}

/**
 * Reports whether replayed tool calls need a thought signature.
 *
 * @param runtimeModel - Backend request model id
 * @returns True for Gemini 3 and newer runtime models
 */
export function requiresThoughtSignature(runtimeModel: string): boolean {
  if (!runtimeModel.startsWith("gemini-")) return false;

  const major = Number.parseInt(runtimeModel.slice("gemini-".length).split(".")[0] ?? "", 10);

  return Number.isNaN(major) ? true : major >= 3;
}

/** Thinking budgets requested from the backend for each non-off level. */
const THINKING_BUDGETS: Partial<Record<ModelThinkingLevel, number>> = {
  minimal: 1_000,
  low: 1_000,
  medium: 4_000,
  // -1 lets the backend spend its own ceiling on deep reasoning levels.
  high: -1,
  xhigh: -1,
  max: -1,
};

/**
 * Builds the thinking configuration for a runtime model and level.
 *
 * @param runtimeModel - Backend request model id
 * @param level - Pi thinking level for this request
 * @returns Thinking configuration, or undefined when the model has no thinking control
 */
export function thinkingConfig(
  runtimeModel: string,
  level: ModelThinkingLevel | undefined,
): ThinkingConfig | undefined {
  const family = runtimeModel.startsWith("gemini-") ? "gemini" : undefined;

  if (family === undefined) return undefined;

  if (level === undefined || level === "off") {
    return { includeThoughts: false, thinkingBudget: 0 };
  }

  if (runtimeModel.startsWith("gemini-3.8-flash-")) {
    const suffix = runtimeModel.slice("gemini-3.8-flash-".length);

    if (suffix === "low") return { includeThoughts: true, thinkingLevel: "LOW" };

    if (suffix === "medium") return { includeThoughts: true, thinkingLevel: "MEDIUM" };

    if (suffix === "high") return { includeThoughts: true, thinkingLevel: "HIGH" };
  }

  return {
    includeThoughts: true,
    thinkingBudget: THINKING_BUDGETS[level] ?? THINKING_BUDGETS.medium ?? 4_000,
  };
}

/** Chat model configuration, narrowed from Pi's mixed-operation model union. */
export type AntigravityModelConfig = Extract<ProviderModelConfig, { maxTokens: number }>;

/**
 * Projects catalog entries into Pi's provider model configuration.
 *
 * @param models - Catalog entries, discovered or fallback
 * @returns Chat model configuration for each entry
 */
export function modelConfigs(
  models: readonly AntigravityModel[] = FALLBACK_MODELS,
): AntigravityModelConfig[] {
  return models.map((model) => ({
    id: model.id,
    name: model.name,
    api: ANTIGRAVITY_API,
    reasoning: model.reasoning,
    thinkingLevelMap: { ...model.thinkingLevelMap },
    input: [...model.input],
    cost: { ...SUBSCRIPTION_COST },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  }));
}
