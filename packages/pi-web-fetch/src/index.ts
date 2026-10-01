import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { redactUrlForDisplay } from "./redact";
import { formatCollapsibleOutput } from "./render";
import { executeWebFetch, resetLlmsNoticeOrigins } from "./service";

export { ExpiringLruCache } from "./cache";

export type { FetchResult } from "./content";

export {
  diagnoseExtraction,
  extractDocumentLinks,
  type ExtractedLink,
  type ExtractedLinks,
  type ExtractionDiagnostics,
} from "./evidence";

export { fetchRemoteContent, type FetchRemoteDependencies } from "./fetch";

export { focusMarkdown, type FocusDetails, type FocusResult } from "./focus";

export { createDocumentOutline, type DocumentOutline, type OutlineHeading } from "./outline";

export { redactUrlForDisplay } from "./redact";

export {
  executeWebFetch,
  type CacheStatus,
  type WebFetchDetails,
  type WebFetchParameters,
  type WebFetchTruncationDetails,
} from "./service";

export {
  FETCH_MAX_BYTES,
  isPrivateAddress,
  requestPinned,
  validateRemoteUrl,
  type ValidatedTarget,
} from "./network";

export const webFetchParameters = Type.Object({
  url: Type.String(),
  query: Type.Optional(Type.String({ description: "Return only matching sections (long pages)." })),
  offset: Type.Optional(
    Type.Integer({ description: "Character offset; use nextOffset to continue." }),
  ),
});

/**
 * Pi web fetch extension that registers the web_fetch tool.
 *
 * @param pi - The extension API instance
 */
export default function (pi: ExtensionAPI) {
  // SAFETY: The host provides `on`; minimal extension test doubles may omit it.
  (pi as ExtensionAPI & { on?: ExtensionAPI["on"] }).on?.("session_start", () =>
    resetLlmsNoticeOrigins(),
  );
  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: "Fetch a public HTTP(S) page as Markdown (6,000 chars per call).",
    parameters: webFetchParameters,

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
