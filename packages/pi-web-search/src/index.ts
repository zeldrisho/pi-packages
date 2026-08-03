import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  SEARCH_CONTEXT_MAX_QUERY_CHARACTERS,
  SEARCH_DEFAULT_RESULT_COUNT,
  SEARCH_MAX_LANGUAGE_CHARACTERS,
  SEARCH_MAX_RESULT_COUNT,
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

const commonSearchParameters = Type.Object({
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
});

export const webSearchParameters = Type.Intersect([
  commonSearchParameters,
  Type.Union([
    Type.Object({
      query: Type.String({
        minLength: 1,
        maxLength: SEARCH_CONTEXT_MAX_QUERY_CHARACTERS,
        description: `The Brave LLM Context query (maximum ${SEARCH_CONTEXT_MAX_QUERY_CHARACTERS} characters)`,
      }),
      mode: Type.Literal("context", {
        description: "Return provider-extracted Brave LLM context",
      }),
    }),
    Type.Object({
      query: Type.String({
        minLength: 1,
        maxLength: SEARCH_WEB_MAX_QUERY_CHARACTERS,
        description: `The web search query (maximum ${SEARCH_WEB_MAX_QUERY_CHARACTERS} characters)`,
      }),
      mode: Type.Optional(
        Type.Literal("web", { description: "Return compact Brave web results (default)" }),
      ),
    }),
  ]),
]);

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

    async execute(_toolCallId, params, signal, onUpdate) {
      return runtime.execute(params, signal, onUpdate);
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
