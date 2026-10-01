import type { IncomingMessage } from "node:http";
import {
  lineFragmentOffsets,
  markdownFragmentOffsets,
  normalizeGitHubRawUrl,
  parseLinkHeaderForAgentHints,
} from "./fetch-metadata";

export { normalizeGitHubRawUrl, parseLinkHeaderForAgentHints } from "./fetch-metadata";

import { awaitWithAbort } from "./abort";
import { sliceCompleteDocument, type CompleteDocument, type FetchResult } from "./content";
import { diagnoseExtraction, extractDocumentLinks, hasExtractionWarning } from "./evidence";
import { extractHtmlToMarkdown } from "./extract";
import { requestFollowingRedirects, type RedirectDependencies } from "./network-redirects";
import type { ValidatedTarget } from "./network-policy";
import { redactUrlForDisplay } from "./redact";
import {
  decodeResponse,
  FETCH_MAX_BYTES,
  readResponseBytes,
  responseHeader,
  responseHeaderValues,
} from "./network-transport";

/** @deprecated Prefer diagnoseExtraction for explicit extraction-quality signals. */
export function detectAppShell(raw: string, markdown: string): boolean {
  return hasExtractionWarning(diagnoseExtraction(raw, markdown));
}

const REQUEST_TIMEOUT_MS = 20_000;

/** Agent-discovery hints advertised in an HTTP `Link:` header. */
export interface LinkHeaderAgentHints {
  describedBy?: string;
  markdownAlternate?: string;
}

export interface FetchRemoteDependencies extends RedirectDependencies {
  extractHtml?: typeof extractHtmlToMarkdown;
  timeoutMs?: number;
}

/**
 * Returns a usable media type from a response header.
 *
 * Some servers incorrectly emit an equivalent media type more than once (for example,
 * `text/html,text/html; charset=utf-8`). Treat that as the declared type, but reject
 * conflicting media types rather than guessing which representation to parse.
 */
function normalizeContentType(header: string): string | undefined {
  const mediaTypes: string[] = [];
  let current = "";
  let quoted = false;

  for (const character of header) {
    if (character === '"') quoted = !quoted;

    if (character === "," && !quoted) {
      mediaTypes.push(current);
      current = "";
    } else current += character;
  }

  mediaTypes.push(current);
  const normalized: string[] = [];

  for (const value of mediaTypes) {
    const mediaType = value.split(";", 1)[0].trim().toLowerCase();

    if (mediaType) normalized.push(mediaType);
  }

  if (normalized.length === 0 || normalized.some((value) => value !== normalized[0])) {
    return undefined;
  }

  return normalized[0];
}

/**
 * Converts a successful HTTP response into a complete document.
 *
 * HTML content is extracted to Markdown, JSON is pretty-printed when valid, and other supported content is returned as trimmed text.
 *
 * @param target - The validated target associated with the response
 * @param response - The HTTP response to process
 * @param signal - Signal used to cancel HTML extraction
 * @returns The document URL, content type, content, optional title, and extractor type
 * @throws If the response has an unsuccessful status or an unsupported content type
 */
async function documentFromResponse(
  target: ValidatedTarget,
  response: IncomingMessage,
  signal: AbortSignal,
  extractHtml: typeof extractHtmlToMarkdown,
): Promise<CompleteDocument> {
  const status = response.statusCode ?? 0;

  if (status < 200 || status >= 300) {
    response.resume();

    const authenticationHint = [401, 403, 404].includes(status)
      ? " The page may be missing, private, or require authentication."
      : "";

    throw new Error(`web_fetch returned HTTP ${status}.${authenticationHint}`);
  }

  const contentTypeHeader =
    responseHeaderValues(response, "content-type").join(", ") || "text/plain";

  const contentType = normalizeContentType(contentTypeHeader);

  const linkHints = parseLinkHeaderForAgentHints(
    responseHeader(response, "link") ?? "",
    target.url,
  );

  const allowed =
    contentType !== undefined &&
    (contentType.startsWith("text/") ||
      [
        "application/json",
        "application/markdown",
        "application/x-markdown",
        "application/xml",
        "application/xhtml+xml",
      ].includes(contentType));

  if (!allowed) {
    response.destroy();
    throw new Error(
      `web_fetch does not support ${contentType ?? (contentTypeHeader || "this content type")}.`,
    );
  }

  const raw = decodeResponse(
    await readResponseBytes(response, FETCH_MAX_BYTES, signal),
    contentTypeHeader,
  );

  if (!raw.trim()) throw new Error("web_fetch: Page has no extractable content.");

  let markdown: string;
  let title: string | undefined;
  let fragmentOffsets: Record<string, number> | undefined;
  let extractor: CompleteDocument["extractor"] = "raw";
  let describedBy: string | undefined = linkHints.describedBy;
  let markdownAlternateUrl: string | undefined = linkHints.markdownAlternate;

  if (contentType === "text/html" || contentType === "application/xhtml+xml") {
    const extracted = await awaitWithAbort(extractHtml(raw, target.url), signal);
    markdown = extracted.markdown;
    title = extracted.title;
    fragmentOffsets = extracted.fragmentOffsets;
    extractor = extracted.extractor;
    describedBy = describedBy ?? extracted.describedByLink;
    markdownAlternateUrl = markdownAlternateUrl ?? extracted.markdownAlternateLink;
  } else if (contentType === "application/json") {
    try {
      markdown = `\`\`\`json\n${JSON.stringify(JSON.parse(raw), null, 2)}\n\`\`\``;
    } catch {
      markdown = raw;
    }
  } else {
    markdown = raw;

    const markdownContent = /\bmarkdown\b|\.md(?:$|[?#])/i.test(
      contentTypeHeader + target.url.pathname,
    );

    if (contentType.startsWith("text/") || markdownContent) {
      fragmentOffsets = lineFragmentOffsets(markdown);

      if (markdownContent) Object.assign(fragmentOffsets, markdownFragmentOffsets(markdown));
    }
  }

  const isHtml = contentType === "text/html" || contentType === "application/xhtml+xml";
  const links = isHtml ? extractDocumentLinks(raw, target.url) : undefined;

  if (
    !markdown.trim() &&
    (!links || (links.internal.length === 0 && links.external.length === 0))
  ) {
    throw new Error("web_fetch: Page has no extractable content.");
  }

  const extractionDiagnostics = isHtml ? diagnoseExtraction(raw, markdown) : undefined;

  const shellSuspected = extractionDiagnostics
    ? hasExtractionWarning(extractionDiagnostics)
    : false;

  const etag = responseHeader(response, "etag");
  const lastModified = responseHeader(response, "last-modified");

  return {
    url: target.url.toString(),
    contentType,
    markdown: markdown.replace(/<\/untrusted_web_content>/gi, "&lt;/untrusted_web_content&gt;"),
    fragmentOffsets,
    title,
    extractor,
    shellSuspected,
    extractionDiagnostics,
    links,
    validators: etag || lastModified ? { etag, lastModified } : undefined,
    cachedAt: Date.now(),
    llmsTxtDescribedBy: describedBy,
    markdownAlternateUrl,
  };
}

/**
 * Validates that a URL string is an absolute http or https URL.
 *
 * @param value - The URL string to validate
 * @returns The parsed URL object
 * @throws If the URL is invalid or not http(s)
 */
function assertAbsoluteHttpUrlForFetch(value: string): URL {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error("web_fetch received an invalid URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`web_fetch only supports http(s) URLs: ${redactUrlForDisplay(url)}`);
  }

  return url;
}

/**
 * Fetches a URL and returns the complete document with extracted content.
 *
 * @param rawUrl - The URL to fetch
 * @param signal - Optional abort signal to cancel the request
 * @param dependencies - Dependencies for network policy validation, transport, and HTML extraction
 * @returns The complete document with extracted markdown content
 * @throws If the request times out, is cancelled, or encounters an error
 */
async function fetchDocument(
  rawUrl: string,
  signal: AbortSignal | undefined,
  dependencies: FetchRemoteDependencies,
  cached?: CompleteDocument,
): Promise<{ document: CompleteDocument; revalidated: boolean }> {
  assertAbsoluteHttpUrlForFetch(normalizeGitHubRawUrl(rawUrl));
  const controller = new AbortController();
  const timeoutMs = dependencies.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const extractHtml = dependencies.extractHtml ?? extractHtmlToMarkdown;
  let timedOut = false;

  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  const conditionalHeaders: Record<string, string> = {};

  if (cached?.validators?.etag) conditionalHeaders["If-None-Match"] = cached.validators.etag;

  if (cached?.validators?.lastModified)
    conditionalHeaders["If-Modified-Since"] = cached.validators.lastModified;

  try {
    const { target, response } = await requestFollowingRedirects(
      normalizeGitHubRawUrl(rawUrl),
      controller.signal,
      dependencies,
      conditionalHeaders,
    );

    if (response.statusCode === 304 && cached) {
      response.resume();
      const etag = responseHeader(response, "etag") ?? cached.validators?.etag;

      const lastModified =
        responseHeader(response, "last-modified") ?? cached.validators?.lastModified;

      return {
        document: {
          ...cached,
          validators: etag || lastModified ? { etag, lastModified } : undefined,
          cachedAt: Date.now(),
        },
        revalidated: true,
      };
    }

    return {
      document: await documentFromResponse(target, response, controller.signal, extractHtml),
      revalidated: false,
    };
  } catch (error) {
    if (timedOut) throw new Error(`web_fetch timed out after ${timeoutMs / 1000} seconds.`);

    if (signal?.aborted) throw new Error("web_fetch was cancelled.");
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", cancel);
  }
}

export async function fetchCompleteDocument(
  rawUrl: string,
  signal: AbortSignal | undefined,
  dependencies: FetchRemoteDependencies,
): Promise<CompleteDocument> {
  return (await fetchDocument(rawUrl, signal, dependencies)).document;
}

/** Revalidates a stale representation with its ETag and Last-Modified validators. */
export async function revalidateCompleteDocument(
  rawUrl: string,
  cached: CompleteDocument,
  signal: AbortSignal | undefined,
  dependencies: FetchRemoteDependencies,
): Promise<{ document: CompleteDocument; revalidated: boolean }> {
  return fetchDocument(rawUrl, signal, dependencies, cached);
}

/**
 * Fetches a URL and returns a slice of the content starting at the given offset.
 *
 * @param rawUrl - The URL to fetch
 * @param offset - The character offset to start slicing from
 * @param maxCharacters - The maximum number of characters to return
 * @param signal - Optional abort signal to cancel the request
 * @param dependencies - Dependencies for network policy validation, transport, and HTML extraction
 * @returns The sliced fetch result with content and metadata
 */
export async function fetchRemoteContent(
  rawUrl: string,
  offset: number,
  maxCharacters: number,
  signal: AbortSignal | undefined,
  dependencies: FetchRemoteDependencies = {},
): Promise<FetchResult> {
  return sliceCompleteDocument(
    await fetchCompleteDocument(rawUrl, signal, dependencies),
    offset,
    maxCharacters,
  );
}
