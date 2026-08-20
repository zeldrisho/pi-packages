import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import {
  searchBraveContext,
  searchBraveWeb,
  validateProviderRequest,
  type Freshness,
  type Provider,
  type SearchMode,
  type SearchResult,
} from "./brave";
import { ExpiringLruCache, stableKeyHash, type CachePersistence } from "./cache";
import { formatResults } from "./format-results";
import { InflightCoalescer } from "./inflight";
import { SEARCH_DEFAULT_RESULT_COUNT } from "./limits";
import { configuredProvider } from "./provider";

const CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const CACHE_MAX_ENTRIES = 100;
const CACHE_MAX_RESULT_BYTES = 20 * 1_024 * 1_024;
const MAX_INFLIGHT_REQUESTS = 100;
const encoder = new TextEncoder();

/** Honest-evidence summary comparing what was requested with what was returned. */
export interface SearchEvidence {
  requestedCount: number;
  returnedCount: number;
  dropped: number;
  freshness?: Freshness;
  truncated: boolean;
}

/** Resolves the private, cross-session cache directory for a web tool. */
function resolveCacheDirectory(name: string): string {
  const base = process.env.XDG_CACHE_HOME
    ? join(process.env.XDG_CACHE_HOME, name)
    : join(homedir(), ".cache", name);
  return base;
}

export interface SearchParameters {
  query: string;
  count?: number;
  freshness?: Freshness;
  mode?: SearchMode;
  language?: string;
}

export interface SearchTruncationDetails {
  truncated: boolean;
  strategy: "temporary-file" | "none";
  fullOutputPath?: string;
  outputBytes: number;
  totalBytes: number;
  outputLines: number;
  totalLines: number;
}

export interface SearchDetails {
  query: string;
  provider: Provider;
  mode: SearchMode;
  resultCount: number;
  results: SearchResult[];
  evidence: SearchEvidence;
  cached: boolean;
  truncated: boolean;
  fullOutputPath?: string;
  truncation: SearchTruncationDetails;
}

interface SearchUpdate {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, never>;
}

const searchCachePersistence: CachePersistence<string, SearchResult[]> = {
  directory: resolveCacheDirectory("pi-web-search"),
  serialize: (results) => encoder.encode(JSON.stringify(results)),
  deserialize: (bytes) => JSON.parse(new TextDecoder().decode(bytes)) as SearchResult[],
  keyToPath: (key) => stableKeyHash(key),
};
const searchCache = new ExpiringLruCache<string, SearchResult[]>(
  CACHE_MAX_ENTRIES,
  CACHE_MAX_RESULT_BYTES,
  (results) => encoder.encode(JSON.stringify(results)).byteLength,
  undefined,
  searchCachePersistence,
);
const inflightSearches = new InflightCoalescer<string, SearchResult[]>(MAX_INFLIGHT_REQUESTS);

export class SearchRuntime {
  readonly #tempDirectories = new Set<string>();

  async shutdown(): Promise<void> {
    const directories = [...this.#tempDirectories];
    await Promise.allSettled(
      directories.map((directory) => rm(directory, { recursive: true, force: true })),
    );
    this.#tempDirectories.clear();
  }

  async execute(
    params: SearchParameters,
    signal: AbortSignal | undefined,
    onUpdate: ((update: SearchUpdate) => void) | undefined,
  ) {
    const query = params.query.trim();
    if (!query) throw new Error("Search query cannot be empty.");

    const count = params.count ?? SEARCH_DEFAULT_RESULT_COUNT;
    const mode = params.mode ?? "web";
    validateProviderRequest(query, count, mode);
    const provider = configuredProvider();
    const cacheKey = JSON.stringify({
      provider,
      mode,
      query,
      count,
      freshness: params.freshness,
      language: params.language,
    });
    const cachedEntry = searchCache.get(cacheKey);
    const cached = cachedEntry !== undefined;
    onUpdate?.({
      content: [
        {
          type: "text",
          text: cached
            ? `Using cached ${provider} results…`
            : `Searching the web with ${provider} (${mode})…`,
        },
      ],
      details: {},
    });

    let results =
      cachedEntry ??
      (await inflightSearches.run(
        cacheKey,
        async (sharedSignal) => {
          const found =
            mode === "context"
              ? await searchBraveContext(
                  query,
                  count,
                  params.freshness,
                  params.language,
                  sharedSignal,
                )
              : await searchBraveWeb(query, count, params.freshness, params.language, sharedSignal);
          const bounded = found.filter((result) => result.url).slice(0, count);
          searchCache.set(cacheKey, bounded, Date.now() + CACHE_TTL_MS);
          return bounded;
        },
        signal,
        "Web search was cancelled.",
      ));

    results = results.filter((result) => result.url).slice(0, count);
    const output = formatResults(query, provider, mode, results);
    const truncation = truncateHead(output, {
      maxLines: DEFAULT_MAX_LINES,
      maxBytes: DEFAULT_MAX_BYTES,
    });
    const evidence: SearchEvidence = {
      requestedCount: count,
      returnedCount: results.length,
      dropped: Math.max(0, results.length - count),
      freshness: params.freshness,
      truncated: truncation.truncated,
    };
    let text = truncation.content;
    let fullOutputPath: string | undefined;

    if (truncation.truncated) {
      const tempDirectory = await mkdtemp(join(tmpdir(), "pi-web-search-"));
      this.#tempDirectories.add(tempDirectory);
      fullOutputPath = join(tempDirectory, "results.txt");
      try {
        await withFileMutationQueue(fullOutputPath, () =>
          writeFile(fullOutputPath!, output, "utf8"),
        );
      } catch (error) {
        await rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
        this.#tempDirectories.delete(tempDirectory);
        throw error;
      }
      text += `\n\n[Output truncated to ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${fullOutputPath}]`;
    }

    return {
      content: [{ type: "text" as const, text }],
      details: {
        query,
        provider,
        mode,
        resultCount: results.length,
        results,
        evidence,
        cached,
        truncated: truncation.truncated,
        fullOutputPath,
        truncation: {
          truncated: truncation.truncated,
          strategy: truncation.truncated ? "temporary-file" : "none",
          fullOutputPath,
          outputBytes: truncation.outputBytes,
          totalBytes: truncation.totalBytes,
          outputLines: truncation.outputLines,
          totalLines: truncation.totalLines,
        },
      } satisfies SearchDetails,
    };
  }
}
