import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { SEARCH_WEB_MAX_QUERY_CHARACTERS } from "./limits";
import { formatCollapsibleOutput } from "./render";
import { SearchRuntime } from "./search";

export { ExpiringLruCache } from "./cache";

export {
  SearchRuntime,
  summarizeDomainDiversity,
  type DomainDiversity,
  type SearchDetails,
  type SearchEvidence,
  type SearchParameters,
  type SearchTruncationDetails,
} from "./search";

export type { BraveQueryMeta, ContextDepth, ContextThresholdMode, SearchResponse } from "./brave";

export const webSearchParameters = Type.Object({
  query: Type.String({
    minLength: 1,
    maxLength: SEARCH_WEB_MAX_QUERY_CHARACTERS,
  }),
  freshness: Type.Optional(StringEnum(["day", "week", "month", "year"] as const)),
  spellcheck: Type.Optional(
    Type.Boolean({ description: "Set false for exact identifiers/error strings." }),
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
    description: "Search the public web (links + snippets). Read a result with web_fetch.",
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
