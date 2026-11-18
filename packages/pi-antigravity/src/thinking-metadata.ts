import { createHash } from "node:crypto";
import type { JsonValue } from "@earendil-works/pi-ai";
import { fetchAvailableModels } from "./discovery.ts";
import { isJsonNumber, isJsonObject } from "./json.ts";
import type { ThinkingConfig } from "./models.ts";

/** The catalog is refreshed independently for each credential and project. */
const TTL_MS = 6 * 60 * 60 * 1000;

/** Extracts only validated wire settings from one catalog entry. */
export function catalogThinkingConfig(
  body: JsonValue | undefined,
  runtimeId: string,
): ThinkingConfig | undefined {
  if (!isJsonObject(body) || !isJsonObject(body.models)) return undefined;
  const model = body.models[runtimeId];

  if (!isJsonObject(model) || model.supportsThinking !== true) return undefined;
  const level = model.thinkingLevel;

  if (level === 1) return { includeThoughts: true, thinkingLevel: "LOW" };

  if (level === 2) return { includeThoughts: true, thinkingLevel: "MEDIUM" };

  if (level === 3) return { includeThoughts: true, thinkingLevel: "HIGH" };

  if (level !== undefined) return undefined;

  const budget = model.thinkingBudget;

  if (isJsonNumber(budget) && Number.isSafeInteger(budget) && budget > 0) {
    return { includeThoughts: true, thinkingBudget: budget };
  }

  return undefined;
}

/** Provides account-scoped live thinking metadata, without persisting credentials. */
export function createThinkingMetadataResolver() {
  let cache: { key: string; expires: number; configs: Map<string, ThinkingConfig> } | undefined;

  return async (
    token: string,
    projectId: string,
    runtimeId: string,
    signal: AbortSignal | undefined,
  ): Promise<ThinkingConfig | undefined> => {
    const key = createHash("sha256")
      .update(JSON.stringify([token, projectId]))
      .digest("hex");

    if (cache?.key === key && cache.expires > Date.now()) {
      return cache.configs.get(runtimeId);
    }

    const body = await fetchAvailableModels(token, projectId, signal);

    if (!isJsonObject(body) || !isJsonObject(body.models)) return undefined;
    const configs = new Map<string, ThinkingConfig>();

    for (const id of Object.keys(body.models)) {
      const config = catalogThinkingConfig(body, id);

      if (config !== undefined) configs.set(id, config);
    }

    cache = { key, expires: Date.now() + TTL_MS, configs };

    return configs.get(runtimeId);
  };
}
