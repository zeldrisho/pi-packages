import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { redactUrlForDisplay } from "./redact";
import { formatCollapsibleOutput } from "./render";
import { executeWebFetch, webFetchOutputSchema } from "./service";

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
  url: Type.String(),
  query: Type.Optional(Type.String({ description: "Find sections matching this text." })),
  offset: Type.Optional(Type.Integer({ description: "Start at this character offset." })),
});

/**
 * Pi web fetch extension that registers the web_fetch tool.
 *
 * @param pi - The extension API instance
 */
export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: "Read a public webpage as Markdown.",
    parameters: webFetchParameters,
    outputSchema: webFetchOutputSchema,

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

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Fetching…"), 0, 0);

      const content = result.content.find((item) => item.type === "text");

      return new Text(
        content?.type === "text"
          ? formatCollapsibleOutput(content.text, expanded, theme)
          : theme.fg("dim", "No content"),
        0,
        0,
      );
    },
  });
}
