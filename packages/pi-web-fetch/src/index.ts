import { getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
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

    /** Renders the redacted URL, optional focus query, and character offset in the call preview. */
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("web_fetch"))} ${theme.fg("accent", redactUrlForDisplay(args.url))}`,
        0,
        0,
      );
    },

    async execute(_toolCallId, params, signal, onUpdate) {
      return executeWebFetch(params, signal, onUpdate);
    },

    /**
     * Renders partial text or "Fetching…" while pending. Completed text gets a
     * detail summary when available and a collapsible body; absent text shows "No content".
     */
    renderResult(result, { expanded, isPartial }, theme) {
      const content = result.content.find((item) => item.type === "text");

      if (isPartial) return new Text(theme.fg("warning", content?.text || "Fetching…"), 0, 0);

      return content?.type === "text"
        ? new Markdown(formatCollapsibleOutput(content.text, expanded), 0, 0, getMarkdownTheme(), {
            color: (text) => theme.fg("toolOutput", text),
          })
        : new Text(theme.fg("dim", "No content"), 0, 0);
    },
  });
}
