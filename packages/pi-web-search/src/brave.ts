import {
  SEARCH_CONTEXT_MAX_QUERY_CHARACTERS,
  SEARCH_MAX_RESULT_COUNT,
  SEARCH_MIN_RESULT_COUNT,
  SEARCH_WEB_MAX_QUERY_CHARACTERS,
} from "./limits";
import { normalizeText, requestJson } from "./provider";

export type Provider = "brave";
export type Freshness = "day" | "week" | "month" | "year";
export type SearchMode = "web" | "context";

export type ResultQuality = "high" | "medium" | "low";

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

const BRAVE_MAX_CONTEXT_TOKENS = 2_048;
const BRAVE_MAX_SNIPPETS = 15;
const BRAVE_MAX_TOKENS_PER_URL = 1_024;
const BRAVE_MAX_SNIPPETS_PER_URL = 3;

/**
 * Validates a search query and requested result count against the provider limits.
 *
 * @param query - The search query to validate
 * @param count - The requested number of results
 * @param mode - The search mode whose query limit applies
 * @throws If the query exceeds the mode limit or the result count is outside the allowed range
 */
export function validateProviderRequest(query: string, count: number, mode: SearchMode): void {
  const maximumQueryCharacters =
    mode === "context" ? SEARCH_CONTEXT_MAX_QUERY_CHARACTERS : SEARCH_WEB_MAX_QUERY_CHARACTERS;
  if (query.length > maximumQueryCharacters) {
    throw new Error(`Search queries cannot exceed ${maximumQueryCharacters} characters.`);
  }
  if (
    !Number.isInteger(count) ||
    count < SEARCH_MIN_RESULT_COUNT ||
    count > SEARCH_MAX_RESULT_COUNT
  ) {
    throw new Error(
      `Search result count must be an integer between ${SEARCH_MIN_RESULT_COUNT} and ${SEARCH_MAX_RESULT_COUNT}.`,
    );
  }
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
 * @param count - The requested number of results
 * @returns Normalized web search results
 */
export async function searchBraveWeb(
  query: string,
  count: number,
  freshness: Freshness | undefined,
  language: string | undefined,
  signal: AbortSignal | undefined,
): Promise<SearchResult[]> {
  validateProviderRequest(query, count, "web");
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(count));
  url.searchParams.set("safesearch", "moderate");
  url.searchParams.set("text_decorations", "false");
  if (language) url.searchParams.set("search_lang", language);
  if (freshness)
    url.searchParams.set(
      "freshness",
      { day: "pd", week: "pw", month: "pm", year: "py" }[freshness],
    );

  const data = await requestJson<BraveWebResponse>(
    url,
    {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": process.env.BRAVE_SEARCH_API_KEY!,
      },
    },
    signal,
  );

  return (data.web?.results ?? []).map((item) => {
    const title = normalizeText(item.title ?? "", 300);
    const snippet = normalizeText(item.description ?? "", 600);
    return {
      title,
      url: normalizeUrl(item.url ?? ""),
      snippet,
      quality: classifyResultQuality({ title, snippet }),
    };
  });
}

/**
 * Searches Brave's context API and maps grounding results to normalized search results.
 *
 * @returns Search results containing normalized titles and URLs with deduplicated Markdown snippets.
 */
export async function searchBraveContext(
  query: string,
  count: number,
  freshness: Freshness | undefined,
  language: string | undefined,
  signal: AbortSignal | undefined,
): Promise<SearchResult[]> {
  validateProviderRequest(query, count, "context");

  const url = new URL("https://api.search.brave.com/res/v1/llm/context");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(count));
  url.searchParams.set("maximum_number_of_urls", String(count));
  url.searchParams.set("maximum_number_of_tokens", String(BRAVE_MAX_CONTEXT_TOKENS));
  url.searchParams.set("maximum_number_of_snippets", String(BRAVE_MAX_SNIPPETS));
  url.searchParams.set("maximum_number_of_tokens_per_url", String(BRAVE_MAX_TOKENS_PER_URL));
  url.searchParams.set("maximum_number_of_snippets_per_url", String(BRAVE_MAX_SNIPPETS_PER_URL));
  url.searchParams.set("context_threshold_mode", "strict");
  if (language) url.searchParams.set("search_lang", language);
  if (freshness)
    url.searchParams.set(
      "freshness",
      { day: "pd", week: "pw", month: "pm", year: "py" }[freshness],
    );

  const data = await requestJson<BraveContextResponse>(
    url,
    {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": process.env.BRAVE_SEARCH_API_KEY!,
      },
    },
    signal,
  );

  return (data.grounding?.generic ?? []).map((item) => {
    const snippets = [
      ...new Set((item.snippets ?? []).map(braveSnippetToMarkdown).filter(Boolean)),
    ];
    const title = normalizeText(item.title ?? "", 300);
    const snippet = snippets.slice(0, BRAVE_MAX_SNIPPETS_PER_URL).join("\n\n");
    return {
      title,
      url: normalizeUrl(item.url ?? ""),
      snippet,
      quality: classifyResultQuality({ title, snippet }),
    };
  });
}
