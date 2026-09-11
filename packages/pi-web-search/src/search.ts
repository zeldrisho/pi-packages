import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { Type } from "typebox";
import { Check } from "typebox/value";
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
  type BraveQueryMeta,
  type ContextDepth,
  type ContextThresholdMode,
  type Freshness,
  type Provider,
  type SafesearchMode,
  type SearchMode,
  type SearchResult,
} from "./brave";
import { ExpiringLruCache, stableKeyHash, type CachePersistence } from "./cache";
import { resolveApiKey, type ApiKeySource } from "./credentials";
import { formatResults } from "./format-results";
import { InflightCoalescer } from "./inflight";
import { SEARCH_DEFAULT_RESULT_COUNT } from "./limits";

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
  uniqueDomains: number;
  topDomainShare: number;
  /** Brave's spellcheck rewrite of the query, when it corrected the request. */
  alteredQuery?: string;
  /** Whether Brave disabled spellcheck for the request. */
  spellcheckOff?: boolean;
  /** True when strict SafeSearch hid results. */
  showStrictWarning?: boolean;
  /** True when more result pages exist (`offset` can page further). */
  moreResultsAvailable?: boolean;
  /** Whether Brave applied search operators from the query. */
  operatorsApplied?: boolean;
  /** Domains extracted from `site:` operators, when Brave reports them. */
  operatorSites?: string[];
  /** Context-mode relevance threshold that was used. */
  threshold?: ContextThresholdMode;
  /** Context-mode token-budget preset that was used. */
  depth?: ContextDepth;
  /** Web-mode result offset that was used. */
  offset?: number;
}

export interface DomainDiversity {
  uniqueDomains: number;
  topDomainShare: number;
}

/** Computes neutral domain-diversity metrics without assigning trust or authority. */
export function summarizeDomainDiversity(results: SearchResult[]): DomainDiversity {
  const counts = new Map<string, number>();
  for (const result of results) {
    try {
      const hostname = new URL(result.url).hostname.toLowerCase().replace(/^www\./, "");
      if (hostname) counts.set(hostname, (counts.get(hostname) ?? 0) + 1);
    } catch {
      // Provider URLs are untrusted; malformed values do not contribute to diversity.
    }
  }
  let largestCount = 0;
  for (const count of counts.values()) largestCount = Math.max(largestCount, count);
  return {
    uniqueDomains: counts.size,
    topDomainShare: results.length > 0 ? largestCount / results.length : 0,
  };
}

/** Resolves the private, cross-session cache directory for a web tool. */
function resolveCacheDirectory(name: string): string {
  const base = process.env.XDG_CACHE_HOME
    ? join(process.env.XDG_CACHE_HOME, name)
    : join(homedir(), ".cache", name);
  return base;
}

/** Parameters for a web search operation. */
export interface SearchParameters {
  query: string;
  count?: number;
  freshness?: Freshness;
  mode?: SearchMode;
  language?: string;
  country?: string;
  safesearch?: SafesearchMode;
  extraSnippets?: boolean;
  /** Apply Brave search operators (`site:`, `filetype:`, quotes, `AND/OR/NOT`); web mode only. */
  operators?: boolean;
  /** Auto-correct the query; set false for exact code identifiers and error strings. */
  spellcheck?: boolean;
  /** Comma-separated `result_filter` values (e.g. `web,discussions,faq`); web mode only. */
  resultFilter?: string;
  /** Single Goggle URL or inline definition for custom ranking; both modes. */
  goggles?: string;
  /** Result page offset (0-9); web mode only. */
  offset?: number;
  /** UI language code (e.g. `en-US`); web mode only. */
  uiLang?: string;
  /** Custom freshness range (`YYYY-MM-DDtoYYYY-MM-DD`); web mode only, exclusive with `freshness`. */
  dateRange?: string;
  /** Relevance threshold for extracted context; context mode only. */
  threshold?: ContextThresholdMode;
  /** Token-budget preset for extracted context (`quick`/`standard`/`deep`); context mode only. */
  depth?: ContextDepth;
}

/** Details about search result truncation and overflow handling. */
export interface SearchTruncationDetails {
  truncated: boolean;
  strategy: "temporary-file" | "none";
  fullOutputPath?: string;
  outputBytes: number;
  totalBytes: number;
  outputLines: number;
  totalLines: number;
}

/** Comprehensive metadata about a search operation result. */
export interface SearchDetails {
  query: string;
  provider: Provider;
  mode: SearchMode;
  resultCount: number;
  results: SearchResult[];
  evidence: SearchEvidence;
  cached: boolean;
  /** Where the Brave API key was found; the key value itself is never reported. */
  apiKeySource: ApiKeySource;
  truncated: boolean;
  fullOutputPath?: string;
  truncation: SearchTruncationDetails;
}

interface SearchUpdate {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, never>;
}

/** Cached provider payload: normalized results plus echoed query metadata. */
interface CachedSearch {
  results: SearchResult[];
  meta: BraveQueryMeta;
  /** Number of provider results before local URL filtering and count bounding. */
  availableCount: number;
}

const cachedSearchSchema = Type.Object({
  results: Type.Array(
    Type.Object({
      title: Type.String(),
      url: Type.String(),
      snippet: Type.String(),
      quality: Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]),
    }),
  ),
  meta: Type.Record(Type.String(), Type.Unknown()),
  availableCount: Type.Integer({ minimum: 0 }),
});

function isCachedSearch(value: CachedSearch): boolean {
  return Check(cachedSearchSchema, value) && value.availableCount >= value.results.length;
}

const searchCachePersistence: CachePersistence<string, CachedSearch> = {
  directory: resolveCacheDirectory("pi-web-search"),
  serialize: (entry) => encoder.encode(JSON.stringify(entry)),
  deserialize: (bytes) => {
    // SAFETY: cache entries are written by this same serializer as a
    // `{ results, meta }` object; older disk entries stored a bare
    // SearchResult[] array and are upgraded here to empty metadata.
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as CachedSearch | SearchResult[];
    if (Array.isArray(parsed)) return { results: parsed, meta: {}, availableCount: parsed.length };
    return parsed;
  },
  validate: isCachedSearch,
  keyToPath: (key) => stableKeyHash(key),
};
const searchCache = new ExpiringLruCache<string, CachedSearch>(
  CACHE_MAX_ENTRIES,
  CACHE_MAX_RESULT_BYTES,
  (results) => encoder.encode(JSON.stringify(results)).byteLength,
  undefined,
  searchCachePersistence,
);
const inflightSearches = new InflightCoalescer<string, CachedSearch>(MAX_INFLIGHT_REQUESTS);

/**
 * Runtime environment for web search operations.
 *
 * Manages temporary files created for truncated search results and provides
 * cleanup on shutdown.
 */
export class SearchRuntime {
  readonly #tempDirectories = new Set<string>();

  /**
   * Cleans up all temporary directories created during search operations.
   *
   * @returns Promise that resolves when all cleanup is complete
   */
  async shutdown(): Promise<void> {
    const directories = [...this.#tempDirectories];
    await Promise.allSettled(
      directories.map((directory) => rm(directory, { recursive: true, force: true })),
    );
    this.#tempDirectories.clear();
  }

  /**
   * Executes a web search with caching, truncation, and progress updates.
   *
   * @param params - Search parameters including query, count, and filters
   * @param signal - Optional abort signal for cancellation
   * @param onUpdate - Optional callback for search progress updates
   * @param cwd - Working directory for credential resolution
   * @returns Promise resolving to search details with results and metadata
   * @throws {Error} When query is empty or API key is missing
   */
  async execute(
    params: SearchParameters,
    signal: AbortSignal | undefined,
    onUpdate: ((update: SearchUpdate) => void) | undefined,
    cwd: string = process.cwd(),
  ) {
    const query = params.query.trim();
    if (!query) throw new Error("Search query cannot be empty.");

    const count = params.count ?? SEARCH_DEFAULT_RESULT_COUNT;
    const mode = params.mode ?? "web";
    const webExtras = {
      country: params.country,
      safesearch: params.safesearch,
      extraSnippets: params.extraSnippets,
      operators: params.operators,
      spellcheck: params.spellcheck,
      resultFilter: params.resultFilter,
      goggles: params.goggles,
      offset: params.offset,
      uiLang: params.uiLang,
      dateRange: params.dateRange,
    };
    const contextExtras = {
      country: params.country,
      safesearch: params.safesearch,
      spellcheck: params.spellcheck,
      goggles: params.goggles,
      threshold: params.threshold,
      depth: params.depth,
    };
    validateProviderRequest(query, count, mode, {
      ...webExtras,
      ...contextExtras,
      extraSnippets: params.extraSnippets,
      operators: params.operators,
      resultFilter: params.resultFilter,
      offset: params.offset,
      uiLang: params.uiLang,
      dateRange: params.dateRange,
      threshold: params.threshold,
      depth: params.depth,
    });
    const credentials = await resolveApiKey(cwd);
    if (!credentials) {
      throw new Error(
        "BRAVE_SEARCH_API_KEY is required for web search. Set it in the environment, the workspace .env, or the agent .env, then run /reload.",
      );
    }
    const provider: Provider = "brave";
    const cacheKey = JSON.stringify({
      provider,
      mode,
      query,
      count,
      freshness: params.freshness,
      language: params.language,
      country: params.country,
      safesearch: params.safesearch,
      extraSnippets: params.extraSnippets,
      operators: params.operators,
      spellcheck: params.spellcheck,
      resultFilter: params.resultFilter,
      goggles: params.goggles,
      offset: params.offset,
      uiLang: params.uiLang,
      dateRange: params.dateRange,
      threshold: params.threshold,
      depth: params.depth,
      cwd,
    });
    const cachedPayload = searchCache.get(cacheKey);
    const cachedEntry = cachedPayload?.results;
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

    const payload =
      cachedPayload ??
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
                  credentials.key,
                  contextExtras,
                )
              : await searchBraveWeb(
                  query,
                  count,
                  params.freshness,
                  params.language,
                  sharedSignal,
                  credentials.key,
                  webExtras,
                );
          const availableCount = found.results.length;
          const bounded = found.results.filter((result) => result.url).slice(0, count);
          const entry: CachedSearch = { results: bounded, meta: found.meta, availableCount };
          searchCache.set(cacheKey, entry, Date.now() + CACHE_TTL_MS);
          return entry;
        },
        signal,
        "Web search was cancelled.",
      ));

    const meta = payload.meta;
    let results = payload.results.filter((result) => result.url).slice(0, count);
    const output = formatResults(query, provider, mode, results);
    const truncation = truncateHead(output, {
      maxLines: DEFAULT_MAX_LINES,
      maxBytes: DEFAULT_MAX_BYTES,
    });
    const evidence: SearchEvidence = {
      requestedCount: count,
      returnedCount: results.length,
      dropped: Math.max(0, payload.availableCount - results.length),
      freshness: params.freshness,
      truncated: truncation.truncated,
      ...summarizeDomainDiversity(results),
    };
    if (meta.altered !== undefined) evidence.alteredQuery = meta.altered;
    if (meta.spellcheckOff !== undefined) evidence.spellcheckOff = meta.spellcheckOff;
    if (meta.showStrictWarning !== undefined) evidence.showStrictWarning = meta.showStrictWarning;
    if (meta.moreResultsAvailable !== undefined)
      evidence.moreResultsAvailable = meta.moreResultsAvailable;
    if (meta.operatorsApplied !== undefined) evidence.operatorsApplied = meta.operatorsApplied;
    if (meta.operatorSites !== undefined) evidence.operatorSites = meta.operatorSites;
    if (mode === "context" && params.threshold !== undefined) evidence.threshold = params.threshold;
    if (mode === "context" && params.depth !== undefined) evidence.depth = params.depth;
    if (mode === "web" && params.offset !== undefined) evidence.offset = params.offset;
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
        apiKeySource: credentials.source,
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
