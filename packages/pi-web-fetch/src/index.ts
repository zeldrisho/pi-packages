import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  FETCH_MAX_OFFSET_CHARACTERS,
  FETCH_MAX_QUERY_CHARACTERS,
  FETCH_MAX_URL_CHARACTERS,
} from "./limits";
import { redactUrlForDisplay } from "./redact";
import { formatCollapsibleOutput } from "./render";
import { executeWebFetch, webFetchOutputSchema, type WebFetchDetails } from "./service";

export { ExpiringLruCache } from "./cache";

export {
  hasAnubisMarkers,
  parseAnubisChallenge,
  solveAnubisChallenge,
  type AnubisChallenge,
  type AnubisSolveContext,
} from "./challenges/anubis.ts";

export { CookieJar } from "./network/cookies.ts";

export type { FetchResult } from "./document/content.ts";

export {
  diagnoseExtraction,
  extractDocumentLinks,
  type ExtractedLink,
  type ExtractedLinks,
  type ExtractionDiagnostics,
} from "./document/evidence.ts";

export {
  fetchRemoteContent,
  npmRegistryFallbackUrl,
  type FetchRemoteDependencies,
} from "./acquisition/fetch.ts";

export { focusMarkdown, type FocusDetails, type FocusResult } from "./document/focus.ts";

export {
  createDocumentOutline,
  type DocumentOutline,
  type OutlineHeading,
} from "./document/outline.ts";

export { redactUrlForDisplay } from "./redact";

export {
  executeWebFetch,
  webFetchOutputSchema,
  type CacheStatus,
  type WebFetchDetails,
  type WebFetchParameters,
  type WebFetchStructuredOutput,
  type WebFetchTruncationDetails,
} from "./service";

export {
  FETCH_MAX_BYTES,
  isPrivateAddress,
  requestPinned,
  validateRemoteUrl,
  type ValidatedTarget,
} from "./network/network.ts";

export const webFetchParameters = Type.Object({
  url: Type.String({ minLength: 1, maxLength: FETCH_MAX_URL_CHARACTERS }),
  query: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: FETCH_MAX_QUERY_CHARACTERS,
      description: "Find sections matching this text.",
    }),
  ),
  offset: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: FETCH_MAX_OFFSET_CHARACTERS,
      description: "Start at this character offset.",
    }),
  ),
});

/**
 * Pi web fetch extension that registers the web_fetch tool.
 *
 * @param pi - The extension API instance
 */
export default function (pi: ExtensionAPI) {
  pi.registerTool<typeof webFetchParameters, Partial<WebFetchDetails>>({
    name: "web_fetch",
    label: "Web Fetch",
    description: "Read a public webpage as Markdown.",
    parameters: webFetchParameters,
    outputSchema: webFetchOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },

    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("web_fetch"))} ${theme.fg("accent", redactUrlForDisplay(args.url))}${args.query === undefined ? "" : ` query=${JSON.stringify(args.query)}`}${args.offset === undefined ? "" : ` offset=${args.offset}`}`,
        0,
        0,
      );
    },

    async execute(_toolCallId, params, signal, onUpdate) {
      return executeWebFetch(params, signal, onUpdate);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      const content = result.content.find((item) => item.type === "text");

      if (isPartial) return new Text(theme.fg("warning", content?.text || "Fetching…"), 0, 0);

      const details = result.details;

      const summary =
        details?.characterCount !== undefined
          ? [
              details.extractionDiagnostics?.botWall
                ? "Blocked"
                : `${details.characterCount} characters`,
              details.cacheStatus ?? (details.cached ? "cached" : "miss"),
              ...(details.focus
                ? [`${details.focus.matchedSections}/${details.focus.totalSections} sections`]
                : []),
              ...(details.nextOffset === undefined ? [] : [`next offset=${details.nextOffset}`]),
            ].join(" · ")
          : "";

      return new Text(
        content?.type === "text"
          ? `${theme.fg("dim", summary)}${formatCollapsibleOutput(content.text, expanded, theme)}`
          : theme.fg("dim", "No content"),
        0,
        0,
      );
    },
  });
}
