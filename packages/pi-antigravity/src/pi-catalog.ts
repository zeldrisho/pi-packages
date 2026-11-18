import {
  getSupportedThinkingLevels,
  type JsonValue,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import {
  getBuiltinModelDataGeneratedAt,
  getBuiltinModels,
} from "@earendil-works/pi-ai/providers/all";
import { isJsonNumber, isJsonObject, isJsonText, parseJsonValue } from "./json.ts";

export interface GeminiMetadata {
  levels: readonly ModelThinkingLevel[];
  input: readonly string[];
  contextWindow: number;
  maxTokens: number;
}

/** Installed metadata remains available when pi.dev is offline. */
export function builtinGeminiMetadata(): Map<string, GeminiMetadata> {
  const models = new Map<string, GeminiMetadata>();

  for (const provider of ["google", "google-vertex"] as const) {
    for (const model of getBuiltinModels(provider)) {
      if (!model.id.startsWith("gemini-") || models.has(model.id)) continue;
      models.set(model.id, {
        levels: getSupportedThinkingLevels(model),
        input: model.input,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      });
    }
  }

  return models;
}

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const MAX_BYTES = 2 * 1024 * 1024;

const TIMEOUT_MS = 5000;

/** Accept only bounded, complete capability records; ignore pricing and API routing. */
export function parsePiCatalog(value: JsonValue): Map<string, GeminiMetadata> | undefined {
  if (!Array.isArray(value) || value.length > 10000) return undefined;
  const result = new Map<string, GeminiMetadata>();

  for (const entry of value) {
    if (
      !isJsonObject(entry) ||
      !isJsonText(entry.id) ||
      !/^gemini-[a-z0-9.-]{1,100}$/.test(entry.id)
    )
      continue;

    if (entry.type !== undefined && entry.type !== "chat") continue;

    if (
      (entry.reasoning !== true && entry.reasoning !== false) ||
      !Array.isArray(entry.input) ||
      !entry.input.includes("text")
    )
      continue;

    if (
      !isJsonNumber(entry.contextWindow) ||
      !Number.isSafeInteger(entry.contextWindow) ||
      entry.contextWindow <= 0 ||
      !isJsonNumber(entry.maxTokens) ||
      !Number.isSafeInteger(entry.maxTokens) ||
      entry.maxTokens <= 0
    )
      continue;
    const map = entry.thinkingLevelMap;

    if (map !== undefined && !isJsonObject(map)) continue;

    if (
      isJsonObject(map) &&
      LEVELS.some(
        (level) => map[level] !== undefined && map[level] !== null && !isJsonText(map[level]),
      )
    )
      continue;

    const levels = !entry.reasoning
      ? ["off" as const]
      : LEVELS.filter((level) => {
          const mapped = isJsonObject(map) ? map[level] : undefined;

          return (
            mapped !== null && ((level !== "xhigh" && level !== "max") || mapped !== undefined)
          );
        });

    if (levels.length === 0) continue;
    result.set(entry.id, {
      levels,
      input: entry.input.filter(isJsonText),
      contextWindow: entry.contextWindow,
      maxTokens: entry.maxTokens,
    });
  }

  return result;
}

export interface PiCatalogSnapshot {
  entries: JsonValue[];
  lastModified: number;
  etag?: string;
}

export interface PiCatalogSnapshots {
  google?: PiCatalogSnapshot;
  vertex?: PiCatalogSnapshot;
}

/** Reject corrupt or incomplete cached bodies before using their validators. */
export function restorePiSnapshots(value: JsonValue | undefined): PiCatalogSnapshots {
  if (!isJsonObject(value)) return {};

  const restore = (entry: JsonValue | undefined): PiCatalogSnapshot | undefined => {
    if (
      !isJsonObject(entry) ||
      !Array.isArray(entry.entries) ||
      !isJsonNumber(entry.lastModified) ||
      entry.lastModified < 0
    )
      return undefined;
    const parsed = parsePiCatalog(entry.entries);

    if (parsed === undefined || parsed.size !== entry.entries.length) return undefined;

    if (
      entry.etag !== undefined &&
      (!isJsonText(entry.etag) || entry.etag.length > 1024 || /[\r\n]/.test(entry.etag))
    )
      return undefined;

    return {
      entries: [...entry.entries],
      lastModified: entry.lastModified,
      etag: isJsonText(entry.etag) ? entry.etag : undefined,
    };
  };

  return { google: restore(value.google), vertex: restore(value.vertex) };
}

/** Project validated public records to the fields needed for future revalidation. */
function snapshotEntries(models: ReadonlyMap<string, GeminiMetadata>): JsonValue[] {
  return [...models].map(([id, model]) => ({
    id,
    type: "chat",
    reasoning: !(model.levels.length === 1 && model.levels[0] === "off"),
    input: [...model.input],
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    thinkingLevelMap: Object.fromEntries(
      LEVELS.map((level) => [level, model.levels.includes(level) ? level : null]),
    ),
  }));
}

/** Refresh both public catalogs with independent validators and bounded responses. */
export async function fetchGeminiMetadata(
  signal: AbortSignal,
  cached: PiCatalogSnapshots = {},
): Promise<{
  models: Map<string, GeminiMetadata>;
  snapshots: PiCatalogSnapshots;
  completed: boolean;
  httpStatus?: number;
}> {
  const bundled = builtinGeminiMetadata();

  const fetchProvider = async (
    provider: "google" | "google-vertex",
    prior: PiCatalogSnapshot | undefined,
  ) => {
    try {
      const headers = new Headers({ Accept: "application/json" });
      const validator = prior?.entries.length ? prior.etag : undefined;

      if (validator) headers.set("If-None-Match", validator);

      const response = await fetch(`https://pi.dev/api/models/providers/${provider}?types=chat`, {
        headers,
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
      });

      if (response.status === 304 && validator && prior)
        return { snapshot: prior, completed: true };

      if (response.status === 404 || response.status === 501) {
        await response.body?.cancel();

        return { snapshot: { entries: [], lastModified: 0 }, completed: true };
      }

      if (!response.ok) {
        await response.body?.cancel();

        return { snapshot: prior, completed: prior !== undefined, httpStatus: response.status };
      }

      if (response.body === null) return { snapshot: prior, completed: false };
      const length = Number(response.headers.get("content-length"));

      if (Number.isFinite(length) && length > MAX_BYTES) {
        await response.body.cancel();

        return { snapshot: prior, completed: false };
      }

      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;

      try {
        while (true) {
          const { done, value } = await reader.read();

          if (done) break;
          total += value.byteLength;

          if (total > MAX_BYTES) {
            await reader.cancel();

            return { snapshot: prior, completed: false };
          }

          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }

      const bytes = new Uint8Array(total);
      let offset = 0;

      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }

      const body = parseJsonValue(new TextDecoder().decode(bytes));
      const models = parsePiCatalog(body);

      if (models === undefined || (Array.isArray(body) && body.length > 0 && models.size === 0))
        return { snapshot: prior, completed: false };
      const date = Date.parse(response.headers.get("last-modified") ?? "");
      const etag = response.headers.get("etag");

      return {
        snapshot: {
          entries: snapshotEntries(models),
          lastModified: Number.isNaN(date) ? 0 : date,
          etag: etag !== null && etag.length <= 1024 && !/[\r\n]/.test(etag) ? etag : undefined,
        },
        completed: true,
      };
    } catch (error) {
      if (signal.aborted) throw error;

      return { snapshot: prior, completed: false };
    }
  };

  const [google, vertex] = await Promise.all([
    fetchProvider("google", cached.google),
    fetchProvider("google-vertex", cached.vertex),
  ]);

  const generatedAt = getBuiltinModelDataGeneratedAt();

  const overlay = (snapshot: PiCatalogSnapshot | undefined) => {
    if (
      snapshot === undefined ||
      (generatedAt !== undefined && snapshot.lastModified <= generatedAt)
    )
      return;

    for (const [id, model] of parsePiCatalog(snapshot.entries) ?? []) bundled.set(id, model);
  };

  overlay(vertex.snapshot);
  overlay(google.snapshot);

  return {
    models: bundled,
    snapshots: { google: google.snapshot, vertex: vertex.snapshot },
    completed: google.completed && vertex.completed,
    httpStatus: google.httpStatus ?? vertex.httpStatus,
  };
}
