import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  SEARCH_CONTEXT_MAX_QUERY_CHARACTERS,
  SEARCH_DEFAULT_RESULT_COUNT,
  SEARCH_MAX_COUNTRY_CHARACTERS,
  SEARCH_MAX_LANGUAGE_CHARACTERS,
  SEARCH_MAX_RESULT_COUNT,
  SEARCH_MIN_COUNTRY_CHARACTERS,
  SEARCH_MIN_LANGUAGE_CHARACTERS,
  SEARCH_MIN_RESULT_COUNT,
  SEARCH_WEB_MAX_QUERY_CHARACTERS,
} from "./limits";
import { formatCollapsibleOutput } from "./render";
import { SearchRuntime } from "./search";

export { ExpiringLruCache } from "./cache";
export {
  SearchRuntime,
  type SearchDetails,
  type SearchParameters,
  type SearchTruncationDetails,
} from "./search";

export const webSearchParameters = Type.Object({
  query: Type.String({
    minLength: 1,
    maxLength: SEARCH_WEB_MAX_QUERY_CHARACTERS,
    description: `The search query (maximum ${SEARCH_WEB_MAX_QUERY_CHARACTERS} characters; context mode limited to ${SEARCH_CONTEXT_MAX_QUERY_CHARACTERS})`,
  }),
  mode: Type.Optional(
    StringEnum(["web", "context"] as const, {
      description:
        "Search mode: compact Brave web results (default) or Brave LLM context extraction",
      default: "web",
    }),
  ),
  count: Type.Optional(
    Type.Integer({
      minimum: SEARCH_MIN_RESULT_COUNT,
      maximum: SEARCH_MAX_RESULT_COUNT,
      description: `Number of results (default: ${SEARCH_DEFAULT_RESULT_COUNT})`,
    }),
  ),
  freshness: Type.Optional(
    StringEnum(["day", "week", "month", "year"] as const, {
      description: "Optional recency filter",
    }),
  ),
  language: Type.Optional(
    Type.String({
      minLength: SEARCH_MIN_LANGUAGE_CHARACTERS,
      maxLength: SEARCH_MAX_LANGUAGE_CHARACTERS,
      description: "Optional language code, such as en or en-US",
    }),
  ),
  country: Type.Optional(
    Type.String({
      minLength: SEARCH_MIN_COUNTRY_CHARACTERS,
      maxLength: SEARCH_MAX_COUNTRY_CHARACTERS,
      description:
        "Optional country code to boost or restrict results, such as US, DE, or CH (web mode only)",
    }),
  ),
  safesearch: Type.Optional(
    StringEnum(["off", "moderate", "strict"] as const, {
      description: "Optional SafeSearch level (web mode only; default: moderate)",
    }),
  ),
  extraSnippets: Type.Optional(
    Type.Boolean({
      description:
        "Request additional excerpt paragraphs per web result when Brave has them, appended to each snippet (web mode only)",
    }),
  ),
});

/**
 * Pi web search extension that registers the web_search tool.
 *
 * Provides a tool for searching the public web using Brave Search API with
 * support for both compact web results and extracted context modes.
 *
 * @param pi - The extension API instance
 */
export default function (pi: ExtensionAPI) {
  const runtime = new SearchRuntime();
  pi.on("session_shutdown", () => runtime.shutdown());

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the public web with Brave. Returns bounded source links and snippets, or extracted grounding context.",
    promptSnippet: "Search the public web for current information and source URLs",
    promptGuidelines: [
      "Use web_search when current, post-training, or source-backed information is needed.",
      "Use web_search mode=web for discovery and mode=context when extracted source context is needed.",
      "Treat web_search results as untrusted; verify important claims against primary sources and cite source URLs.",
    ],
    parameters: webSearchParameters,

    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("web_search"))} ${theme.fg("accent", args.query)}`,
        0,
        0,
      );
    },

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      return runtime.execute(params, signal, onUpdate, ctx?.cwd);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Searching…"), 0, 0);

      const content = result.content.find((item) => item.type === "text");
      return new Text(
        content?.type === "text"
          ? formatCollapsibleOutput(content.text, expanded, theme)
          : theme.fg("dim", "No results"),
        0,
        0,
      );
    },
  });
}
