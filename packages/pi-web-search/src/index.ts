import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { SEARCH_WEB_MAX_QUERY_CHARACTERS } from "./limits";
import { renderCollapsibleOutput } from "./render";
import { SearchRuntime, webSearchOutputSchema, type SearchDetails } from "./search";

export { ExpiringLruCache } from "./cache";

export {
  SearchRuntime,
  summarizeDomainDiversity,
  webSearchOutputSchema,
  type DomainDiversity,
  type SearchDetails,
  type SearchEvidence,
  type SearchParameters,
  type SearchResultType,
  type SearchTruncationDetails,
  type WebSearchStructuredOutput,
} from "./search";

export type { BraveQueryMeta, SearchMode, SearchResponse } from "./brave";

export type { BraveAnswer } from "./answers";

export const webSearchParameters = Type.Object({
  query: Type.String({
    minLength: 1,
    maxLength: SEARCH_WEB_MAX_QUERY_CHARACTERS,
  }),
});

/**
 * Pi web search extension that registers the web_search tool.
 *
 * Provides a tool for searching the public web using Brave Search API with
 * support for web results and generated-answer fallback when no results are found.
 *
 * @param pi - The extension API instance
 */
export default function (pi: ExtensionAPI) {
  const runtime = new SearchRuntime();
  pi.on("session_shutdown", () => runtime.shutdown());

  pi.registerTool<typeof webSearchParameters, Partial<SearchDetails>>({
    name: "web_search",
    label: "Web Search",
    description: "Search the web.",
    parameters: webSearchParameters,
    outputSchema: webSearchOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },

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

    /**
     * Renders partial text or "Searching…" while pending. Completed text gets a
     * result and cache summary when available and a collapsible body; absent text shows "No results".
     */
    renderResult(result, { expanded, isPartial }, theme, context) {
      const content = result.content.find((item) => item.type === "text");

      if (isPartial) return new Text(theme.fg("warning", content?.text || "Searching…"), 0, 0);

      return content?.type === "text"
        ? renderCollapsibleOutput(
            content.text,
            expanded,
            theme,
            context?.isError,
            result.details?.fullOutputPath
              ? `[${result.details.truncation?.truncated ? "Output truncated. " : "Structured payload omitted. "}Full output: ${result.details.fullOutputPath}]`
              : undefined,
          )
        : new Text(theme.fg("dim", "No results"), 0, 0);
    },
  });
}
