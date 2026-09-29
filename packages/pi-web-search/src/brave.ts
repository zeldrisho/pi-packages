import { SEARCH_RESULT_FILTER_VALUES } from "./limits";
import { normalizeText, requestJson } from "./provider";
import { normalizeResultFilter, validateProviderRequest } from "./request-validation";

export { normalizeResultFilter, validateProviderRequest } from "./request-validation";

export type Provider = "brave";

export type Freshness = "day" | "week" | "month" | "year";

export type SafesearchMode = "off" | "moderate" | "strict";

export type SearchMode = "web" | "context";

/** Relevance threshold for the LLM context endpoint. */
export type ContextThresholdMode = "strict" | "balanced" | "lenient" | "disabled";

/** Token-budget preset for the LLM context endpoint (coding-oriented). */
export type ContextDepth = "quick" | "standard" | "deep";

/** Allowed Brave `result_filter` values. */
export type ResultFilterValue = (typeof SEARCH_RESULT_FILTER_VALUES)[number];

export type ResultQuality = "high" | "medium" | "low";

/** Query metadata Brave echoes back (spellcheck, operators, pagination hints). */
export interface BraveQueryMeta {
  altered?: string;
  cleaned?: string;
  spellcheckOff?: boolean;
  showStrictWarning?: boolean;
  moreResultsAvailable?: boolean;
  operatorsApplied?: boolean;
  cleanedQuery?: string;
  operatorSites?: string[];
}

interface BraveQuery {
  original?: string;
  altered?: string;
  cleaned?: string;
  spellcheck_off?: boolean;
  show_strict_warning?: boolean;
  more_results_available?: boolean;
  search_operators?: {
    applied?: boolean;
    cleaned_query?: string;
    sites?: string[];
  };
}

/** Normalized provider response: results plus echoed query metadata. */
export interface SearchResponse {
  results: SearchResult[];
  meta: BraveQueryMeta;
}

/**
 * Parses Brave's echoed `query` object into neutral evidence metadata.
 *
 * The response body is already decoded to the `BraveQuery` contract by
 * `requestJson` at the transport boundary, so this maps known fields without
 * re-narrowing their representation.
 *
 * @param query - The raw `query` object from a Brave response
 * @returns Normalized metadata; empty when Brave echoes nothing
 */
export function parseQueryMeta(query: BraveQuery | undefined): BraveQueryMeta {
  if (!query) return {};
  const meta: BraveQueryMeta = {};

  if (query.altered) meta.altered = query.altered;

  if (query.cleaned) meta.cleaned = query.cleaned;

  if (query.spellcheck_off !== undefined) meta.spellcheckOff = query.spellcheck_off;

  if (query.show_strict_warning !== undefined) meta.showStrictWarning = query.show_strict_warning;

  if (query.more_results_available !== undefined)
    meta.moreResultsAvailable = query.more_results_available;
  const operators = query.search_operators;

  if (operators) {
    if (operators.applied !== undefined) meta.operatorsApplied = operators.applied;

    if (operators.cleaned_query) meta.cleanedQuery = operators.cleaned_query;

    if (Array.isArray(operators.sites)) meta.operatorSites = [...operators.sites];
  }

  return meta;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** Honest-evidence hint about how useful the result is likely to be as a citation. */
  quality: ResultQuality;
}

interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
  extra_snippets?: string[];
}

interface BraveWebResponse {
  web?: { results?: BraveWebResult[] };
}

interface BraveSnippet {
  caption?: string;
  table?: Array<Record<string, string>>;
}

interface BraveContextResult {
  title?: string;
  url?: string;
  snippets?: string[];
}

interface BraveContextResponse {
  grounding?: { generic?: BraveContextResult[] };
}

/** Every search option Brave accepts across both modes; per-mode support is enforced by validation. */
export interface ProviderRequestExtras {
  country?: string;
  safesearch?: SafesearchMode;
  spellcheck?: boolean;
  /** Single Goggle URL or inline definition (`$discard`, `$site=`, `boost=`). */
  goggles?: string;
  extraSnippets?: boolean;
  operators?: boolean;
  /** Comma-separated `result_filter` values (e.g. `web,discussions,faq`). */
  resultFilter?: string;
  offset?: number;
  uiLang?: string;
  /** Custom freshness range (`YYYY-MM-DDtoYYYY-MM-DD`); exclusive with `freshness`. */
  dateRange?: string;
  threshold?: ContextThresholdMode;
  depth?: ContextDepth;
}

/** Web-mode search options. */
export interface WebSearchExtras {
  country?: string;
  safesearch?: SafesearchMode;
  spellcheck?: boolean;
  /** Single Goggle URL or inline definition (`$discard`, `$site=`, `boost=`). */
  goggles?: string;
  extraSnippets?: boolean;
  operators?: boolean;
  /** Comma-separated `result_filter` values (e.g. `web,discussions,faq`). */
  resultFilter?: string;
  offset?: number;
  uiLang?: string;
  /** Custom freshness range (`YYYY-MM-DDtoYYYY-MM-DD`); exclusive with `freshness`. */
  dateRange?: string;
}

/** Context-mode search options. */
export interface ContextSearchExtras {
  country?: string;
  safesearch?: SafesearchMode;
  spellcheck?: boolean;
  /** Single Goggle URL or inline definition (`$discard`, `$site=`, `boost=`). */
  goggles?: string;
  threshold?: ContextThresholdMode;
  depth?: ContextDepth;
}

/**
 * Classifies a search result by how much usable, sourced information it carries.
 *
 * @param result - The result title and snippet to assess
 * @returns A coarse quality hint for weighting citations
 */
export function classifyResultQuality(result: { title: string; snippet: string }): ResultQuality {
  if (!result.title && !result.snippet) return "low";

  if (result.snippet.length >= 80) return "high";

  if (result.title || result.snippet) return "medium";

  return "low";
}

const CONTEXT_DEPTH_BUDGETS = {
  quick: { tokens: 2_048, snippets: 15, tokensPerUrl: 1_024, snippetsPerUrl: 3 },
  standard: { tokens: 8_192, snippets: 30, tokensPerUrl: 2_048, snippetsPerUrl: 5 },
  deep: { tokens: 16_384, snippets: 50, tokensPerUrl: 4_096, snippetsPerUrl: 8 },
} satisfies Record<
  ContextDepth,
  { tokens: number; snippets: number; tokensPerUrl: number; snippetsPerUrl: number }
>;

const BRAVE_MAX_EXTRA_SNIPPETS = 5;

/**
 * Maps `freshness`/`dateRange` tool options to Brave's `freshness` parameter.
 *
 * @param freshness - The named recency bucket, if any
 * @param dateRange - The custom date range, if any (exclusive with `freshness`)
 * @returns The Brave `freshness` value
 * @throws If both options are set at once
 */
export function mapFreshness(
  freshness: Freshness | undefined,
  dateRange: string | undefined,
): string | undefined {
  if (freshness && dateRange) {
    throw new Error("Search freshness and dateRange are mutually exclusive; set only one.");
  }

  if (dateRange) return dateRange;

  if (freshness) return { day: "pd", week: "pw", month: "pm", year: "py" }[freshness];

  return undefined;
}

/**
 * Normalizes an HTTP or HTTPS URL and limits the result to 2,048 characters.
 *
 * @param value - The URL text to normalize
 * @returns The normalized URL, or an empty string for invalid values or unsupported protocols
 */
function normalizeUrl(value: string): string {
  try {
    const url = new URL(value);

    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString().slice(0, 2048)
      : "";
  } catch {
    return "";
  }
}

function escapeMarkdownLinkText(value: string): string {
  return value.replace(/([\\[\]])/g, "\\$1");
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

/** Renders a structured Brave snippet as a bounded Markdown table when possible. */
function structuredSnippetToMarkdown(value: BraveSnippet): string | undefined {
  const table = value.table;

  if (!table || table.length === 0) return undefined;

  const rows = table.filter(Boolean);
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];

  if (headers.length === 0) return undefined;

  const caption = value.caption ? `**${escapeMarkdownLinkText(value.caption)}**\n\n` : "";
  const header = `| ${headers.map(escapeMarkdownCell).join(" | ")} |`;
  const separator = `| ${headers.map(() => "---").join(" | ")} |`;

  const body = rows
    .map((row) => `| ${headers.map((key) => escapeMarkdownCell(String(row[key]))).join(" | ")} |`)
    .join("\n");

  return `${caption}${header}\n${separator}\n${body}`;
}

/** Converts a Brave structured snippet payload to bounded, display-safe Markdown. */
function braveSnippetToMarkdown(value: string): string {
  try {
    const snippet = value.trim();

    if (!snippet) return "";
    const parsed: BraveSnippet = JSON.parse(snippet);
    const rendered = structuredSnippetToMarkdown(parsed);

    if (rendered !== undefined) return rendered.slice(0, 8000);

    return `\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\``.slice(0, 8000);
  } catch {
    return String(value)
      .replace(/\r\n/g, "\n")
      .replace(/\n{4,}/g, "\n\n\n")
      .slice(0, 8000);
  }
}

/**
 * Searches the Brave web index for matching results.
 *
 * @param query - The search query
 * @param count - The requested number of results (1-20 in web mode)
 * @param apiKey - The resolved Brave subscription token (never logged or echoed)
 * @param extras - Optional web-mode filters: country, safesearch, operators, spellcheck, result filter, goggles, pagination, freshness range
 * @returns Normalized web search results plus echoed query metadata
 */
export async function searchBraveWeb(
  query: string,
  count: number,
  freshness: Freshness | undefined,
  language: string | undefined,
  signal: AbortSignal | undefined,
  apiKey: string,
  extras: WebSearchExtras = {},
): Promise<SearchResponse> {
  validateProviderRequest(query, count, "web", extras);
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(count));
  url.searchParams.set("safesearch", extras.safesearch ?? "moderate");
  url.searchParams.set("text_decorations", "false");

  if (language) url.searchParams.set("search_lang", language);

  if (extras.country) url.searchParams.set("country", extras.country.toUpperCase());

  if (extras.extraSnippets) url.searchParams.set("extra_snippets", "true");

  if (extras.operators !== undefined) url.searchParams.set("operators", String(extras.operators));

  if (extras.spellcheck !== undefined)
    url.searchParams.set("spellcheck", String(extras.spellcheck));

  if (extras.resultFilter)
    url.searchParams.set("result_filter", normalizeResultFilter(extras.resultFilter));

  if (extras.goggles) url.searchParams.set("goggles", extras.goggles);

  if (extras.offset !== undefined) url.searchParams.set("offset", String(extras.offset));

  if (extras.uiLang) url.searchParams.set("ui_lang", extras.uiLang);
  const mappedFreshness = mapFreshness(freshness, extras.dateRange);

  if (mappedFreshness) url.searchParams.set("freshness", mappedFreshness);

  const data = await requestJson<BraveWebResponse & { query?: BraveQuery }>(
    url,
    {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey,
      },
    },
    signal,
  );

  return {
    results: (data.web?.results ?? []).map((item) => {
      const title = normalizeText(item.title ?? "", 300);
      let snippet = normalizeText(item.description ?? "", 600);

      if (extras.extraSnippets && item.extra_snippets?.length) {
        const additional = item.extra_snippets
          .slice(0, BRAVE_MAX_EXTRA_SNIPPETS)
          .map((value) => normalizeText(value ?? "", 300))
          .filter(Boolean);

        if (additional.length) {
          snippet = normalizeText([snippet, ...additional].filter(Boolean).join("\n\n"), 2000);
        }
      }

      return {
        title,
        url: normalizeUrl(item.url ?? ""),
        snippet,
        quality: classifyResultQuality({ title, snippet }),
      };
    }),
    meta: parseQueryMeta(data.query),
  };
}

/**
 * Searches Brave's context API and maps grounding results to normalized search results.
 *
 * @param apiKey - The resolved Brave subscription token (never logged or echoed)
 * @param extras - Optional context-mode tuning: country, safesearch, spellcheck, goggles, relevance threshold, token-budget depth
 * @returns Search results containing normalized titles and URLs with deduplicated Markdown snippets, plus echoed query metadata.
 */
export async function searchBraveContext(
  query: string,
  count: number,
  freshness: Freshness | undefined,
  language: string | undefined,
  signal: AbortSignal | undefined,
  apiKey: string,
  extras: ContextSearchExtras = {},
): Promise<SearchResponse> {
  validateProviderRequest(query, count, "context", extras);
  const budget = CONTEXT_DEPTH_BUDGETS[extras.depth ?? "quick"];

  const url = new URL("https://api.search.brave.com/res/v1/llm/context");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(count));
  url.searchParams.set("maximum_number_of_urls", String(count));
  url.searchParams.set("maximum_number_of_tokens", String(budget.tokens));
  url.searchParams.set("maximum_number_of_snippets", String(budget.snippets));
  url.searchParams.set("maximum_number_of_tokens_per_url", String(budget.tokensPerUrl));
  url.searchParams.set("maximum_number_of_snippets_per_url", String(budget.snippetsPerUrl));
  url.searchParams.set("context_threshold_mode", extras.threshold ?? "strict");

  if (language) url.searchParams.set("search_lang", language);

  if (extras.country) url.searchParams.set("country", extras.country.toUpperCase());

  if (extras.safesearch) url.searchParams.set("safesearch", extras.safesearch);

  if (extras.spellcheck !== undefined)
    url.searchParams.set("spellcheck", String(extras.spellcheck));

  if (extras.goggles) url.searchParams.set("goggles", extras.goggles);

  if (freshness)
    url.searchParams.set(
      "freshness",
      { day: "pd", week: "pw", month: "pm", year: "py" }[freshness],
    );

  const data = await requestJson<BraveContextResponse & { query?: BraveQuery }>(
    url,
    {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey,
      },
    },
    signal,
  );

  return {
    results: (data.grounding?.generic ?? []).map((item) => {
      const snippets = [
        ...new Set((item.snippets ?? []).map(braveSnippetToMarkdown).filter(Boolean)),
      ];

      const title = normalizeText(item.title ?? "", 300);
      const snippet = snippets.slice(0, budget.snippetsPerUrl).join("\n\n");

      return {
        title,
        url: normalizeUrl(item.url ?? ""),
        snippet,
        quality: classifyResultQuality({ title, snippet }),
      };
    }),
    meta: parseQueryMeta(data.query),
  };
}
