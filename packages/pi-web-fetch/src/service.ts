import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { Check } from "typebox/value";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  type AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import { ExpiringLruCache, stableKeyHash, type CachePersistence } from "./cache";
import { sliceCompleteDocument, type CompleteDocument } from "./document/content.ts";
import { revalidateCompleteDocument, type FetchRemoteDependencies } from "./acquisition/fetch.ts";
import { fetchDocumentWithLlmsTxtSupport } from "./acquisition/llms.ts";
import { focusMarkdown, type FocusDetails } from "./document/focus.ts";
import { resolveFragmentOffset, urlWithoutFragment } from "./document/fragments.ts";
import { InflightCoalescer } from "./inflight";
import { createDocumentOutline, type DocumentOutline } from "./document/outline.ts";
import { redactUrlForDisplay } from "./redact";
import {
  FETCH_DEFAULT_MAX_CHARACTERS,
  FETCH_DEFAULT_OFFSET,
  FETCH_MAX_CHARACTERS,
  FETCH_MAX_OFFSET_CHARACTERS,
  FETCH_MAX_QUERY_CHARACTERS,
  FETCH_MIN_MAX_CHARACTERS,
} from "./limits";

const CACHE_TTL_MS = 24 * 60 * 60 * 1_000;

const CACHE_STALE_RETENTION_MS = 7 * CACHE_TTL_MS;

const CACHE_MAX_ENTRIES = 100;

const CACHE_MAX_MARKDOWN_BYTES = 20 * 1_024 * 1_024;

const MAX_INFLIGHT_REQUESTS = 100;

/** Minimum extracted length for both the low-quality trigger and llms.txt acceptance. */
const encoder = new TextEncoder();

/** Coarse classification of what kind of page a fetch returned. */
export type ContentKind =
  | "repository-readme"
  | "code-file"
  | "directory-listing"
  | "llms-index"
  | "article"
  | "raw-text"
  | "markup-shell"
  | "unknown";

/** Confidence that the returned content faithfully represents the source page. */
export type FetchConfidence = "high" | "medium" | "low";

/** Cache evidence for this call. */
export type CacheStatus = "hit" | "revalidated" | "miss";

function safeUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/**
 * Classify the kind of content returned by a fetch operation.
 *
 * Determines the content type based on URL patterns, extractor used,
 * and whether an app shell was detected.
 *
 * @param url - The fetched URL
 * @param extractor - Extraction method used
 * @param shellSuspected - Whether the page appears to be an app shell
 * @returns Content classification
 */
export function classifyContentKind(
  url: string,
  extractor: CompleteDocument["extractor"],
  shellSuspected: boolean,
): ContentKind {
  if (shellSuspected) return "markup-shell";
  const parsed = safeUrl(url);
  const host = parsed?.hostname ?? "";
  const path = parsed?.pathname ?? "";

  if (host === "github.com" && path.includes("/tree/")) return "directory-listing";

  if (path === "/llms.txt" || path.endsWith("/llms.txt")) return "llms-index";

  if (host === "raw.githubusercontent.com" || host === "gist.githubusercontent.com")
    return "code-file";

  if (host === "github.com") {
    const segments = path.split("/").filter(Boolean);

    if (!path.includes("/blob/") && segments.length <= 2) return "repository-readme";
  }

  if (extractor === "raw") return "raw-text";

  if (extractor === "defuddle") return "article";

  return "unknown";
}

/**
 * Classify confidence level for fetched content quality.
 *
 * Determines how confident we are that the extracted content accurately
 * represents the source page, based on extraction method and content length.
 *
 * @param extractor - Extraction method used
 * @param shellSuspected - Whether the page appears to be an app shell
 * @param markdownLength - Length of extracted markdown content
 * @returns Confidence level (high, medium, or low)
 */
export function classifyConfidence(
  extractor: CompleteDocument["extractor"],
  shellSuspected: boolean,
  markdownLength: number,
): FetchConfidence {
  if (shellSuspected) return "low";

  if (extractor === "raw") return "high";

  if (extractor === "defuddle") return markdownLength >= 200 ? "high" : "medium";

  return markdownLength >= 200 ? "medium" : "low";
}

export { buildLlmsTxtCandidateUrls } from "./acquisition/llms.ts";

/** Resolves the private, cross-session cache directory for a web tool. */
function resolveCacheDirectory(name: string): string {
  const base = process.env.XDG_CACHE_HOME
    ? join(process.env.XDG_CACHE_HOME, name)
    : join(homedir(), ".cache", name);

  return base;
}

/** Parameters for a web fetch operation. */
export interface WebFetchParameters {
  /** Public URL; an optional #fragment starts output at the matching heading/anchor. */
  url: string;
  /** Optional query used to select matching Markdown sections before continuation slicing. */
  query?: string;
  offset?: number;
  maxCharacters?: number;
}

/** Details about content truncation and pagination strategy. */
export interface WebFetchTruncationDetails {
  truncated: boolean;
  strategy: "continuation" | "none";
  nextOffset?: number;
}

/** Comprehensive metadata about a web fetch result. */
export interface WebFetchDetails {
  url: string;
  requestedUrl: string;
  finalUrl: string;
  contentType: string;
  title?: string;
  extractor: CompleteDocument["extractor"];
  contentKind: ContentKind;
  /** @deprecated Use extractionDiagnostics for explicit quality evidence. */
  shellSuspected: boolean;
  extractionDiagnostics?: CompleteDocument["extractionDiagnostics"];
  links?: CompleteDocument["links"];
  confidence: FetchConfidence;
  /** Bounded document-shape metadata for the complete, unfiltered document. Heading text is untrusted remote content. */
  outline: DocumentOutline;
  /** Deterministic focused-extraction evidence when a query was supplied. */
  focus?: FocusDetails;
  /** True when the returned content is the site's /llms.txt served instead of the requested page. */
  llmsTxtFallback: boolean;
  /** True when the returned content is the page's advertised Markdown version served instead of a low-quality page. */
  markdownAlternateFallback: boolean;
  /** The site's /llms.txt index URL when one exists and the returned content is not that index itself. */
  llmsTxtUrl?: string;
  /** True for a fresh cache hit or a successful 304 revalidation. */
  cached: boolean;
  cacheStatus: CacheStatus;
  truncated: boolean;
  offset: number;
  nextOffset?: number;
  totalCharacters: number;
  characterCount: number;
  truncation: WebFetchTruncationDetails;
  fragment?: { requested: string; matched: boolean; offset?: number };
}

interface WebFetchUpdate {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, never>;
}

/** Machine-readable result declared by `web_fetch`'s `outputSchema`. */
export interface WebFetchStructuredOutput {
  requestedUrl: string;
  finalUrl: string;
  title?: string;
  contentType: string;
  extractor: CompleteDocument["extractor"];
  contentKind: ContentKind;
  confidence: FetchConfidence;
  cacheStatus: CacheStatus;
  blocked: boolean;
  markdown: string;
  truncated: boolean;
  offset: number;
  nextOffset?: number;
  totalCharacters: number;
  characterCount: number;
  llmsTxtFallback: boolean;
  markdownAlternateFallback: boolean;
  extraction?: CompleteDocument["extractionDiagnostics"];
  focus?: FocusDetails;
  outline: { totalWords: number; totalHeadings: number; omittedHeadings: number };
  fragment?: { requested: string; matched: boolean; offset?: number };
}

/** JSON Schema of the machine-readable `web_fetch` result. */
export const webFetchOutputSchema = Type.Object({
  requestedUrl: Type.String(),
  finalUrl: Type.String(),
  title: Type.Optional(Type.String()),
  contentType: Type.String(),
  extractor: Type.Union([Type.Literal("raw"), Type.Literal("basic"), Type.Literal("defuddle")]),
  contentKind: Type.String(),
  confidence: Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]),
  cacheStatus: Type.Union([Type.Literal("hit"), Type.Literal("revalidated"), Type.Literal("miss")]),
  blocked: Type.Boolean(),
  markdown: Type.String(),
  truncated: Type.Boolean(),
  offset: Type.Integer(),
  nextOffset: Type.Optional(Type.Integer()),
  totalCharacters: Type.Integer(),
  characterCount: Type.Integer(),
  llmsTxtFallback: Type.Boolean(),
  markdownAlternateFallback: Type.Boolean(),
  extraction: Type.Optional(
    Type.Object({
      javascriptRequired: Type.Boolean(),
      botWall: Type.Boolean(),
      consentInterstitial: Type.Boolean(),
      sparseExtraction: Type.Boolean(),
      rawCharacters: Type.Integer(),
      extractedCharacters: Type.Integer(),
    }),
  ),
  focus: Type.Optional(
    Type.Object({
      query: Type.String(),
      matchedSections: Type.Integer(),
      totalSections: Type.Integer(),
      omittedSections: Type.Integer(),
      originalCharacters: Type.Integer(),
      focusedCharacters: Type.Integer(),
    }),
  ),
  outline: Type.Object({
    totalWords: Type.Integer(),
    totalHeadings: Type.Integer(),
    omittedHeadings: Type.Integer(),
  }),
  fragment: Type.Optional(
    Type.Object({
      requested: Type.String(),
      matched: Type.Boolean(),
      offset: Type.Optional(Type.Integer()),
    }),
  ),
});

const completeDocumentCacheSchema = Type.Object(
  {
    url: Type.String(),
    contentType: Type.String(),
    markdown: Type.String(),
    fragmentOffsets: Type.Optional(Type.Record(Type.String(), Type.Number())),
    extractor: Type.Union([Type.Literal("raw"), Type.Literal("basic"), Type.Literal("defuddle")]),
    shellSuspected: Type.Boolean(),
    title: Type.Optional(Type.String()),
    extractionDiagnostics: Type.Optional(
      Type.Object({
        javascriptRequired: Type.Boolean(),
        botWall: Type.Boolean(),
        consentInterstitial: Type.Boolean(),
        sparseExtraction: Type.Boolean(),
        rawCharacters: Type.Number(),
        extractedCharacters: Type.Number(),
      }),
    ),
    links: Type.Optional(
      Type.Object({
        internal: Type.Array(
          Type.Object({
            url: Type.String(),
            anchorText: Type.String(),
          }),
        ),
        external: Type.Array(
          Type.Object({
            url: Type.String(),
            anchorText: Type.String(),
          }),
        ),
        omittedInternal: Type.Number(),
        omittedExternal: Type.Number(),
      }),
    ),
    cachedAt: Type.Optional(Type.Number()),
    validators: Type.Optional(
      Type.Object({
        etag: Type.Optional(Type.String()),
        lastModified: Type.Optional(Type.String()),
      }),
    ),
    llmsTxtFallback: Type.Optional(Type.Boolean()),
    llmsTxtIndexUrl: Type.Optional(Type.String()),
    llmsTxtDescribedBy: Type.Optional(Type.String()),
    markdownAlternateUrl: Type.Optional(Type.String()),
    markdownAlternateFallback: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: true },
);

function isCompleteDocument(value: CompleteDocument): boolean {
  return Check(completeDocumentCacheSchema, value);
}

const fetchCachePersistence: CachePersistence<string, CompleteDocument> = {
  directory: resolveCacheDirectory("pi-web-fetch"),
  serialize: (document) => encoder.encode(JSON.stringify(document)),
  // SAFETY: JSON is validated immediately below before entering the cache.
  deserialize: (bytes) => JSON.parse(new TextDecoder().decode(bytes)) as CompleteDocument,
  validate: isCompleteDocument,
  keyToPath: (key) => stableKeyHash(key),
};

const fetchCache = new ExpiringLruCache<string, CompleteDocument>(
  CACHE_MAX_ENTRIES,
  CACHE_MAX_MARKDOWN_BYTES,
  (document) => encoder.encode(document.markdown).byteLength,
  undefined,
  fetchCachePersistence,
);

interface FetchAcquisition {
  document: CompleteDocument;
  cacheStatus: Exclude<CacheStatus, "hit">;
}

const inflightFetches = new InflightCoalescer<string, FetchAcquisition>(MAX_INFLIGHT_REQUESTS);

/**
 * Executes a validated web fetch, including caching, focusing, and bounded pagination.
 *
 * A URL fragment selects the starting heading, anchor, or source range unless
 * an explicit offset is supplied. A query selects sections before pagination.
 * Missing fragments may suggest up to three links to other pages with that
 * fragment. Discovered llms.txt index URLs appear on every unblocked result,
 * including cache hits. Detected bot-wall documents return a blocked result
 * without page content.
 *
 * @param params - Fetch options; offsets and character limits count UTF-16 code units
 * @param params.offset - Integer from 0 to 20,000,000; applies to the focused view when querying
 * @param params.maxCharacters - Integer from 1,000 to 30,000; defaults to 6,000 before line/byte limits
 * @param signal - Cancels acquisition; fresh cache hits do not consult this signal
 * @param onUpdate - Receives cache or acquisition progress before content is returned
 * @returns Bounded text, structured content, and metadata. Structured Markdown may
 *   be shorter to fit JSON byte limits; use its own nextOffset for continuation.
 * @throws For invalid parameter limits; acquisition, cancellation, and progress callback errors propagate
 */
export async function executeWebFetch(
  params: WebFetchParameters,
  signal: AbortSignal | undefined,
  onUpdate: ((update: WebFetchUpdate) => void) | undefined,
  dependencies: FetchRemoteDependencies = {},
) {
  const explicitOffset = params.offset;
  const offset = explicitOffset ?? FETCH_DEFAULT_OFFSET;
  const maxCharacters = params.maxCharacters ?? FETCH_DEFAULT_MAX_CHARACTERS;

  if (!Number.isInteger(offset) || offset < 0 || offset > FETCH_MAX_OFFSET_CHARACTERS) {
    throw new Error(
      `web_fetch offset must be an integer between 0 and ${FETCH_MAX_OFFSET_CHARACTERS}.`,
    );
  }

  if (
    !Number.isInteger(maxCharacters) ||
    maxCharacters < FETCH_MIN_MAX_CHARACTERS ||
    maxCharacters > FETCH_MAX_CHARACTERS
  ) {
    throw new Error(
      `web_fetch maxCharacters must be an integer between ${FETCH_MIN_MAX_CHARACTERS} and ${FETCH_MAX_CHARACTERS}.`,
    );
  }

  if (
    params.query !== undefined &&
    (params.query.trim().length === 0 || params.query.length > FETCH_MAX_QUERY_CHARACTERS)
  ) {
    throw new Error(
      `web_fetch query must contain between 1 and ${FETCH_MAX_QUERY_CHARACTERS} characters.`,
    );
  }

  if (params.url.length < 1 || params.url.length > 2_048) {
    throw new Error("web_fetch url must contain between 1 and 2048 characters.");
  }

  const displayRequestedUrl = redactUrlForDisplay(params.url);
  const sourceUrl = urlWithoutFragment(params.url);
  let document = fetchCache.get(sourceUrl);
  const now = Date.now();

  const fresh = Boolean(
    document &&
    !document.extractionDiagnostics?.botWall &&
    (document.cachedAt === undefined || now - document.cachedAt < CACHE_TTL_MS),
  );

  let cacheStatus: CacheStatus = fresh ? "hit" : "miss";
  onUpdate?.({
    content: [
      {
        type: "text",
        text: fresh
          ? `Using cached content for ${displayRequestedUrl}…`
          : document
            ? `Revalidating cached content for ${displayRequestedUrl}…`
            : `Fetching ${displayRequestedUrl}…`,
      },
    ],
    details: {},
  });

  if (!fresh) {
    const stale = document;

    const acquisition = await inflightFetches.run(
      sourceUrl,
      async (sharedSignal) => {
        let fetched: CompleteDocument;
        let acquisitionStatus: FetchAcquisition["cacheStatus"] = "miss";

        if (stale?.validators && !stale.llmsTxtFallback && !stale.markdownAlternateFallback) {
          const outcome = await revalidateCompleteDocument(
            sourceUrl,
            stale,
            sharedSignal,
            dependencies,
          );

          fetched = outcome.document;
          acquisitionStatus = outcome.revalidated ? "revalidated" : "miss";
        } else {
          fetched = await fetchDocumentWithLlmsTxtSupport(sourceUrl, sharedSignal, dependencies);
        }

        if (!fetched.extractionDiagnostics?.botWall) {
          fetchCache.set(sourceUrl, fetched, Date.now() + CACHE_STALE_RETENTION_MS);
        }

        return { document: fetched, cacheStatus: acquisitionStatus };
      },
      signal,
      "web_fetch was cancelled.",
    );

    document = acquisition.document;
    cacheStatus = acquisition.cacheStatus;
  }

  if (!document) throw new Error("web_fetch failed to acquire a document.");
  const blocked = Boolean(document.extractionDiagnostics?.botWall);

  // Keep acquisition diagnostics, but never expose challenge prose, links, or continuation.
  if (blocked)
    document = {
      ...document,
      markdown: "",
      title: undefined,
      links: undefined,
      fragmentOffsets: undefined,
    };
  const resolvedFragment = resolveFragmentOffset(document, params.url);
  const fragmentOffset = resolvedFragment.offset;
  const fragmentMatched = resolvedFragment.fragment !== undefined && fragmentOffset !== undefined;

  const fragmentSuggestions =
    resolvedFragment.fragment !== undefined && !fragmentMatched
      ? [
          ...(document.links?.internal ?? []).map((link) => link.url),
          ...(document.links?.external ?? []).map((link) => link.url),
          ...[...document.markdown.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1]),
        ]
          .filter((url) => {
            try {
              const linkedUrl = new URL(url, document.url);

              if (decodeURIComponent(linkedUrl.hash.slice(1)) !== resolvedFragment.fragment) {
                return false;
              }

              linkedUrl.hash = "";
              const sourceUrl = new URL(document.url);
              sourceUrl.hash = "";

              return linkedUrl.href !== sourceUrl.href;
            } catch {
              return false;
            }
          })
          .slice(0, 3)
          .map((url) => redactUrlForDisplay(new URL(url, document.url).href))
      : [];

  const startingOffset = explicitOffset ?? fragmentOffset ?? FETCH_DEFAULT_OFFSET;

  const hasFragmentRange =
    explicitOffset === undefined &&
    fragmentOffset !== undefined &&
    resolvedFragment.endOffset !== undefined;

  const fragmentDocument =
    explicitOffset === undefined && fragmentOffset !== undefined
      ? {
          ...document,
          markdown: hasFragmentRange
            ? document.markdown.slice(fragmentOffset, resolvedFragment.endOffset)
            : document.markdown.slice(fragmentOffset),
        }
      : document;

  const focused =
    blocked || params.query === undefined
      ? undefined
      : focusMarkdown(fragmentDocument.markdown, params.query);

  const outputDocument = focused
    ? { ...fragmentDocument, markdown: focused.markdown }
    : fragmentDocument;

  const resultOffset = blocked
    ? 0
    : focused
      ? (explicitOffset ?? 0)
      : (explicitOffset ?? (fragmentMatched ? 0 : startingOffset));

  const result = sliceCompleteDocument(outputDocument, resultOffset, maxCharacters);

  const displayLinks =
    result.links === undefined
      ? undefined
      : {
          ...result.links,
          internal: result.links.internal.map((link) => ({
            ...link,
            url: redactUrlForDisplay(link.url),
          })),
          external: result.links.external.map((link) => ({
            ...link,
            url: redactUrlForDisplay(link.url),
          })),
        };

  const requestedUrl = displayRequestedUrl;
  const rawFinalUrl = result.url;
  const finalUrl = redactUrlForDisplay(rawFinalUrl);
  const shellSuspected = result.shellSuspected;
  const contentKind = classifyContentKind(rawFinalUrl, result.extractor, shellSuspected);
  const confidence = classifyConfidence(result.extractor, shellSuspected, result.markdown.length);

  const requestedPath = safeUrl(params.url)?.pathname.replace(/\/+$/u, "").toLowerCase();
  const finalPath = safeUrl(result.url)?.pathname.replace(/\/+$/u, "").toLowerCase();
  const requestedLlmsIndex = requestedPath?.endsWith("/llms.txt") ?? false;
  const finalIsLlmsIndex = finalPath?.endsWith("/llms.txt") ?? false;

  const showLlmsNotice =
    Boolean(result.llmsTxtIndexUrl) && !requestedLlmsIndex && !finalIsLlmsIndex;

  const output = blocked
    ? "Blocked by an anti-bot challenge. Requested page content is unavailable."
    : [
        ...(result.markdownAlternateFallback
          ? [
              "[The requested page looked like an app shell or had little readable text, so this is the Markdown version advertised by the site instead.]",
              "",
            ]
          : []),
        ...(result.llmsTxtFallback
          ? [
              "[Showing the site's documentation index instead of the requested page. Follow a relevant link to read the documentation.]",
              "",
            ]
          : []),
        ...(showLlmsNotice && result.llmsTxtIndexUrl
          ? [
              `Documentation index available: ${redactUrlForDisplay(result.llmsTxtIndexUrl)}. Use it if this page does not cover the topic.`,
              "",
            ]
          : []),
        ...(resolvedFragment.fragment !== undefined && !fragmentMatched
          ? [
              "[The requested URL fragment was not found; showing the page from the beginning.]",
              ...(fragmentSuggestions.length
                ? [`[This page links to the requested fragment: ${fragmentSuggestions.join(", ")}]`]
                : []),
              "",
            ]
          : []),
        ...(fragmentMatched ? ["[Starting at the requested URL fragment.]", ""] : []),
        ...(focused
          ? [
              focused.details.matchedSections > 0
                ? `[Showing ${focused.details.matchedSections} of ${focused.details.totalSections} source sections selected by the focus query. Offsets apply to this focused view; omit query to read the complete document.]`
                : "[No source sections matched the focus query. Omit query to read the complete document.]",
              "",
            ]
          : []),
        result.markdown || (focused ? "" : "[The page contained no readable text.]"),
      ].join("\n");

  const outputTruncation = truncateHead(output, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });

  const truncated = result.truncated || outputTruncation.truncated;
  const outline = createDocumentOutline(document.markdown);

  const structured: WebFetchStructuredOutput = {
    requestedUrl,
    finalUrl,
    title: result.title?.slice(0, 500),
    contentType: result.contentType,
    extractor: result.extractor,
    contentKind,
    confidence,
    cacheStatus,
    blocked,
    markdown: outputDocument.markdown.slice(result.offset, result.nextOffset),
    truncated: result.truncated,
    offset: result.offset,
    nextOffset: result.nextOffset,
    totalCharacters: result.totalCharacters,
    characterCount: 0,
    llmsTxtFallback: Boolean(result.llmsTxtFallback),
    markdownAlternateFallback: Boolean(result.markdownAlternateFallback),
    extraction: result.extractionDiagnostics,
    focus: focused?.details,
    outline: {
      totalWords: outline.totalWords,
      totalHeadings: outline.totalHeadings,
      omittedHeadings: outline.omittedHeadings,
    },
    fragment:
      resolvedFragment.fragment === undefined
        ? undefined
        : {
            requested: resolvedFragment.fragment,
            matched: fragmentMatched,
            offset: fragmentOffset,
          },
  };

  structured.characterCount = structured.markdown.length;

  // JSON escaping consumes a separate byte budget. If it needs a shorter chunk,
  // advance only by the content actually returned to programmatic callers.
  while (
    encoder.encode(JSON.stringify(structured)).byteLength > DEFAULT_MAX_BYTES &&
    structured.markdown.length > 0
  ) {
    let end = Math.floor(structured.markdown.length / 2);

    if (end > 0 && /[\uD800-\uDBFF]/u.test(structured.markdown[end - 1])) end -= 1;

    structured.markdown = structured.markdown.slice(0, end);
    structured.characterCount = end;
    structured.nextOffset = result.offset + end;
    structured.truncated = true;
  }

  // SAFETY: this DTO contains only bounded JSON data; serialization omits optional
  // undefined properties so the emitted value matches the declared output schema.
  const structuredContent = JSON.parse(JSON.stringify(structured)) as NonNullable<
    AgentToolResult["structuredContent"]
  >;

  return {
    content: [{ type: "text" as const, text: outputTruncation.content }],
    structuredContent,
    details: {
      url: finalUrl,
      requestedUrl,
      finalUrl,
      contentType: result.contentType,
      title: result.title,
      extractor: result.extractor,
      contentKind,
      shellSuspected,
      extractionDiagnostics: result.extractionDiagnostics,
      links: displayLinks,
      confidence,
      outline,
      focus: focused?.details,
      llmsTxtFallback: Boolean(result.llmsTxtFallback),
      markdownAlternateFallback: Boolean(result.markdownAlternateFallback),
      llmsTxtUrl:
        result.llmsTxtIndexUrl === undefined
          ? undefined
          : redactUrlForDisplay(result.llmsTxtIndexUrl),
      cached: cacheStatus !== "miss",
      cacheStatus,
      truncated,
      offset: result.offset,
      nextOffset: result.nextOffset,
      totalCharacters: result.totalCharacters,
      characterCount: result.markdown.length,
      truncation: {
        truncated,
        strategy: truncated ? "continuation" : "none",
        nextOffset: result.nextOffset,
      },
      fragment:
        resolvedFragment.fragment === undefined
          ? undefined
          : {
              requested: resolvedFragment.fragment,
              matched: fragmentMatched,
              offset: fragmentOffset,
            },
    } satisfies WebFetchDetails,
  };
}
