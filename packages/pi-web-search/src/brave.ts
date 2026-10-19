import { SEARCH_RESULT_FILTER_VALUES } from "./limits";
import { normalizeText, requestJson } from "./provider";
import { normalizeResultFilter, validateProviderRequest } from "./request-validation";

export { normalizeResultFilter, validateProviderRequest } from "./request-validation";

export type Provider = "brave";

export type SafesearchMode = "off" | "moderate" | "strict";

export type SearchMode = "web" | "answers";

export type ResultFilterValue = (typeof SEARCH_RESULT_FILTER_VALUES)[number];

export type ResultQuality = "high" | "medium" | "low";

/** Neutral query metadata echoed by Brave, not a measure of correctness. */
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
  altered?: string;
  cleaned?: string;
  spellcheck_off?: boolean;
  show_strict_warning?: boolean;
  more_results_available?: boolean;
  search_operators?: { applied?: boolean; cleaned_query?: string; sites?: string[] };
}

export interface SearchResponse {
  results: SearchResult[];
  meta: BraveQueryMeta;
}

export function parseQueryMeta(query: BraveQuery | undefined): BraveQueryMeta {
  if (!query) return {};
  const meta: BraveQueryMeta = {};

  if (query.altered) meta.altered = query.altered;

  if (query.cleaned) meta.cleaned = query.cleaned;

  if (query.spellcheck_off !== undefined) meta.spellcheckOff = query.spellcheck_off;

  if (query.show_strict_warning !== undefined) meta.showStrictWarning = query.show_strict_warning;

  if (query.more_results_available !== undefined)
    meta.moreResultsAvailable = query.more_results_available;

  if (query.search_operators?.applied !== undefined)
    meta.operatorsApplied = query.search_operators.applied;

  if (query.search_operators?.cleaned_query)
    meta.cleanedQuery = query.search_operators.cleaned_query;

  if (Array.isArray(query.search_operators?.sites))
    meta.operatorSites = [...query.search_operators.sites];

  return meta;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** Coarse source-content hint, not calibrated confidence or authority. */
  quality: ResultQuality;
}

interface BraveWebResponse {
  web?: {
    results?: Array<{
      title?: string;
      url?: string;
      description?: string;
      extra_snippets?: string[];
    }>;
  };
  query?: BraveQuery;
}

export interface ProviderRequestExtras {
  country?: string;
  safesearch?: SafesearchMode;
  goggles?: string;
  extraSnippets?: boolean;
  operators?: boolean;
  resultFilter?: string;
  offset?: number;
  uiLang?: string;
  dateRange?: string;
}

export type WebSearchExtras = ProviderRequestExtras;

export function classifyResultQuality(result: { title: string; snippet: string }): ResultQuality {
  if (!result.title && !result.snippet) return "low";

  if (result.snippet.length >= 80) return "high";

  return "medium";
}

/** Only normalized HTTP(S) URLs are exposed as source links. */
export function normalizeUrl(value: string): string {
  try {
    const url = new URL(value);

    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password
      ? url.toString().slice(0, 2048)
      : "";
  } catch {
    return "";
  }
}

/** Searches Brave's web index; does not invoke Answers or fetch result URLs. */
export async function searchBraveWeb(
  query: string,
  count: number,
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

  if (extras.resultFilter)
    url.searchParams.set("result_filter", normalizeResultFilter(extras.resultFilter));

  if (extras.goggles) url.searchParams.set("goggles", extras.goggles);

  if (extras.offset !== undefined) url.searchParams.set("offset", String(extras.offset));

  if (extras.uiLang) url.searchParams.set("ui_lang", extras.uiLang);

  if (extras.dateRange) url.searchParams.set("freshness", extras.dateRange);

  const data = await requestJson<BraveWebResponse>(
    url,
    {
      headers: { Accept: "application/json", "X-Subscription-Token": apiKey },
    },
    signal,
  );

  return {
    results: (data.web?.results ?? []).map((item) => {
      const title = normalizeText(item.title ?? "", 300);
      let snippet = normalizeText(item.description ?? "", 600);

      if (extras.extraSnippets && item.extra_snippets?.length) {
        const additional = item.extra_snippets
          .slice(0, 5)
          .map((value) => normalizeText(value ?? "", 300))
          .filter(Boolean);

        if (additional.length)
          snippet = normalizeText([snippet, ...additional].filter(Boolean).join("\n\n"), 2000);
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
