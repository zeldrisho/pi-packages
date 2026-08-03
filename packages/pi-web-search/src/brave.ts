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

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
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
 * @param maximumQueryCharacters - The maximum permitted query length
 * @throws If the query exceeds the maximum length or the result count is outside the allowed range
 */
function validateProviderRequest(
  query: string,
  count: number,
  maximumQueryCharacters: number,
): void {
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
 * @param value - The value to normalize
 * @returns The normalized URL, or an empty string for invalid values or unsupported protocols
 */
function normalizeUrl(value: unknown): string {
  if (typeof value !== "string") return "";
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

function escapeMarkdownCell(value: unknown): string {
  let text = "";
  if (typeof value === "string") text = value;
  else if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    text = String(value);
  } else if (value !== null && value !== undefined) {
    try {
      text = JSON.stringify(value) ?? "";
    } catch {
      text = "";
    }
  }
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

function structuredSnippetToMarkdown(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as { caption?: unknown; table?: unknown };
  if (!Array.isArray(record.table) || record.table.length === 0) return undefined;

  const rows = record.table.filter(
    (row): row is Record<string, unknown> => Boolean(row) && typeof row === "object",
  );
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  if (headers.length === 0) return undefined;

  const caption =
    typeof record.caption === "string" ? `**${escapeMarkdownLinkText(record.caption)}**\n\n` : "";
  const header = `| ${headers.map(escapeMarkdownCell).join(" | ")} |`;
  const separator = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows
    .map((row) => `| ${headers.map((key) => escapeMarkdownCell(row[key])).join(" | ")} |`)
    .join("\n");
  return `${caption}${header}\n${separator}\n${body}`;
}

function braveSnippetToMarkdown(value: unknown): string {
  if (typeof value !== "string") return "";
  const snippet = value.trim();
  if (!snippet) return "";

  try {
    const parsed = JSON.parse(snippet) as unknown;
    return (
      structuredSnippetToMarkdown(parsed) ??
      `\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\``
    ).slice(0, 8000);
  } catch {
    return snippet
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
  validateProviderRequest(query, count, SEARCH_WEB_MAX_QUERY_CHARACTERS);
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

  const data = (await requestJson(
    url,
    {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": process.env.BRAVE_SEARCH_API_KEY!,
      },
    },
    signal,
  )) as { web?: { results?: Array<{ title?: unknown; url?: unknown; description?: unknown }> } };

  return (data.web?.results ?? []).map((item) => ({
    title: normalizeText(item.title, 300),
    url: normalizeUrl(item.url),
    snippet: normalizeText(item.description, 600),
  }));
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
  validateProviderRequest(query, count, SEARCH_CONTEXT_MAX_QUERY_CHARACTERS);

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

  const data = (await requestJson(
    url,
    {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": process.env.BRAVE_SEARCH_API_KEY!,
      },
    },
    signal,
  )) as {
    grounding?: { generic?: Array<{ title?: unknown; url?: unknown; snippets?: unknown[] }> };
  };

  return (data.grounding?.generic ?? []).map((item) => {
    const snippets = [
      ...new Set((item.snippets ?? []).map(braveSnippetToMarkdown).filter(Boolean)),
    ];
    return {
      title: normalizeText(item.title, 300),
      url: normalizeUrl(item.url),
      snippet: snippets.slice(0, BRAVE_MAX_SNIPPETS_PER_URL).join("\n\n"),
    };
  });
}
