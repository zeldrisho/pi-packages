import type { IncomingMessage } from "node:http";
import {
  lineFragmentOffsets,
  markdownFragmentOffsets,
  normalizeGitHubRawUrl,
  parseLinkHeaderForAgentHints,
} from "./fetch-metadata.ts";

export { normalizeGitHubRawUrl, parseLinkHeaderForAgentHints } from "./fetch-metadata.ts";

import { awaitWithAbort } from "../abort";
import {
  hasAnubisMarkers,
  parseAnubisChallenge,
  solveAnubisChallenge,
} from "../challenges/anubis.ts";
import {
  sliceCompleteDocument,
  type CompleteDocument,
  type FetchResult,
} from "../document/content.ts";
import { CookieJar } from "../network/cookies.ts";
import {
  diagnoseExtraction,
  extractDocumentLinks,
  hasExtractionWarning,
} from "../document/evidence.ts";
import { extractHtmlToMarkdown } from "../document/extract.ts";
import {
  requestFollowingRedirects,
  type RedirectDependencies,
} from "../network/network-redirects.ts";
import type { ValidatedTarget } from "../network/network-policy.ts";
import { redactUrlForDisplay } from "../redact";
import {
  decodeResponse,
  decompressResponse,
  FETCH_MAX_BYTES,
  readResponseBytes,
  responseHeader,
  responseHeaderValues,
} from "../network/network-transport.ts";

/** Maps challenged npm package pages to the public registry endpoint. */
export function npmRegistryFallbackUrl(rawUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl);

    if (url.protocol !== "https:" || url.hostname !== "www.npmjs.com") return undefined;

    const segments = url.pathname.split("/").filter(Boolean);

    if (segments[0] !== "package" || (segments.length !== 2 && segments.length !== 3))
      return undefined;

    const name = segments.length === 3 ? `${segments[1]}/${segments[2]}` : segments[1];

    if (!name || name.includes("\\")) return undefined;

    const registryName = name
      .split("/")
      .map((segment) => encodeURIComponent(segment).replace(/^%40/i, "@"))
      .join("/");

    return `https://registry.npmjs.org/${registryName}/latest`;
  } catch {
    return undefined;
  }
}

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
  /** When false, an Anubis interstitial is reported as blocked instead of solved. Defaults to true. */
  solveAnubisChallenges?: boolean;
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

/** Content types other than `text/*` that web_fetch extracts. */
const ALLOWED_CONTENT_TYPES = [
  "application/json",
  "application/markdown",
  "application/x-markdown",
  "application/xml",
  "application/xhtml+xml",
];

/** A response body decoded once so challenge detection and extraction share it. */
interface DecodedBody {
  raw: string;
  contentTypeHeader: string;
  contentType: string;
}

/** Returns the combined Content-Type header value, defaulting to plain text. */
function responseContentTypeHeader(response: IncomingMessage): string {
  return responseHeaderValues(response, "content-type").join(", ") || "text/plain";
}

/** Narrows a media type to the HTML variants web_fetch extracts. */
function isHtmlContentType(
  value: string | undefined,
): value is "text/html" | "application/xhtml+xml" {
  return value === "text/html" || value === "application/xhtml+xml";
}

/** Narrows a media type to those web_fetch is willing to read. */
function isAllowedContentType(value: string | undefined): value is string {
  return (
    value !== undefined && (value.startsWith("text/") || ALLOWED_CONTENT_TYPES.includes(value))
  );
}

/** Throws the established error for a response whose status is not successful. */
function assertSuccessfulResponse(response: IncomingMessage): void {
  const status = response.statusCode ?? 0;

  if (status >= 200 && status < 300) return;

  const cloudflareChallenge =
    responseHeader(response, "cf-mitigated")?.trim().toLowerCase() === "challenge";

  response.resume();

  if (cloudflareChallenge) {
    throw new Error(`web_fetch was blocked by Cloudflare's anti-bot challenge (HTTP ${status}).`);
  }

  const authenticationHint = [401, 403, 404].includes(status)
    ? " The page may be missing, private, or require authentication."
    : "";

  throw new Error(`web_fetch returned HTTP ${status}.${authenticationHint}`);
}

/** Reads, decompresses, and decodes a response body once. */
async function decodeResponseBody(
  response: IncomingMessage,
  signal: AbortSignal,
  contentTypeHeader: string,
  contentType: string,
): Promise<DecodedBody> {
  const rawBytes = await readResponseBytes(response, FETCH_MAX_BYTES, signal);

  const raw = decodeResponse(
    decompressResponse(rawBytes, responseHeader(response, "content-encoding")),
    contentTypeHeader,
  );

  return { raw, contentTypeHeader, contentType };
}

/**
 * Converts an already-decoded successful response into a complete document.
 *
 * @param target - The validated target associated with the response
 * @param response - The HTTP response whose headers describe the document
 * @param body - The decoded body shared with challenge detection
 * @param signal - Signal used to cancel HTML extraction
 * @param extractHtml - HTML extractor implementation
 * @param allowEmptyContent - Whether an empty document is acceptable
 * @returns The complete extracted document
 */
async function documentFromDecoded(
  target: ValidatedTarget,
  response: IncomingMessage,
  body: DecodedBody,
  signal: AbortSignal,
  extractHtml: typeof extractHtmlToMarkdown,
  allowEmptyContent: boolean,
): Promise<CompleteDocument> {
  const { raw, contentType, contentTypeHeader } = body;

  if (!raw.trim() && !allowEmptyContent)
    throw new Error("web_fetch: Page has no extractable content.");

  const linkHints = parseLinkHeaderForAgentHints(
    responseHeader(response, "link") ?? "",
    target.url,
  );

  let markdown: string;
  let title: string | undefined;
  let fragmentOffsets: Record<string, number> | undefined;
  let extractor: CompleteDocument["extractor"] = "raw";
  let describedBy: string | undefined = linkHints.describedBy;
  let markdownAlternateUrl: string | undefined = linkHints.markdownAlternate;

  if (isHtmlContentType(contentType)) {
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

  const isHtml = isHtmlContentType(contentType);
  const links = isHtml ? extractDocumentLinks(raw, target.url) : undefined;

  if (
    !markdown.trim() &&
    (!links || (links.internal.length === 0 && links.external.length === 0)) &&
    !allowEmptyContent
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
 * Converts a successful HTTP response into a complete document.
 *
 * HTML content is extracted to Markdown, JSON is pretty-printed when valid, and other supported content is returned as trimmed text.
 *
 * @param target - The validated target associated with the response
 * @param response - The HTTP response to process
 * @param signal - Signal used to cancel HTML extraction
 * @param extractHtml - HTML extractor implementation
 * @param allowEmptyContent - Whether an empty document is acceptable
 * @returns The document URL, content type, content, optional title, and extractor type
 * @throws If the response has an unsuccessful status or an unsupported content type
 */
async function documentFromResponse(
  target: ValidatedTarget,
  response: IncomingMessage,
  signal: AbortSignal,
  extractHtml: typeof extractHtmlToMarkdown,
  allowEmptyContent = false,
): Promise<CompleteDocument> {
  assertSuccessfulResponse(response);

  const contentTypeHeader = responseContentTypeHeader(response);
  const contentType = normalizeContentType(contentTypeHeader);

  if (!isAllowedContentType(contentType)) {
    response.destroy();
    throw new Error(
      `web_fetch does not support ${contentType ?? (contentTypeHeader || "this content type")}.`,
    );
  }

  const body = await decodeResponseBody(response, signal, contentTypeHeader, contentType);

  return documentFromDecoded(target, response, body, signal, extractHtml, allowEmptyContent);
}

/**
 * Converts one acquisition response into a document, solving a same-origin
 * Anubis interstitial at most once before extraction.
 *
 * @param target - The validated target associated with the response
 * @param response - The HTTP response to process
 * @param signal - Signal used to cancel extraction and challenge solving
 * @param extractHtml - HTML extractor implementation
 * @param allowEmptyContent - Whether an empty document is acceptable
 * @param dependencies - Fetch dependencies, including the acquisition cookie jar
 * @param allowSolve - Whether an Anubis challenge may be solved on this pass
 * @returns The complete extracted document
 */
async function documentFromAcquisition(
  target: ValidatedTarget,
  response: IncomingMessage,
  signal: AbortSignal,
  extractHtml: typeof extractHtmlToMarkdown,
  allowEmptyContent: boolean,
  dependencies: FetchRemoteDependencies,
  allowSolve: boolean,
): Promise<CompleteDocument> {
  const status = response.statusCode ?? 0;
  const contentTypeHeader = responseContentTypeHeader(response);
  const contentType = normalizeContentType(contentTypeHeader);

  if (
    allowSolve &&
    dependencies.solveAnubisChallenges !== false &&
    status >= 200 &&
    status < 300 &&
    isHtmlContentType(contentType)
  ) {
    const body = await decodeResponseBody(response, signal, contentTypeHeader, contentType);

    if (hasAnubisMarkers(body.raw)) {
      const challenge = parseAnubisChallenge(body.raw, target.url);

      if (challenge) {
        try {
          const passed = await solveAnubisChallenge({
            challenge,
            pageUrl: target.url,
            raw: body.raw,
            dependencies,
            signal,
          });

          return await documentFromAcquisition(
            passed.target,
            passed.response,
            signal,
            extractHtml,
            allowEmptyContent,
            dependencies,
            false,
          );
        } catch (error) {
          if (signal.aborted || (error instanceof Error && error.name === "AbortError"))
            throw error;
          // Any other failure degrades to the standard blocked output below.
        }
      }

      // An unsolvable challenge, denial, or error page is returned as blocked.
      return documentFromDecoded(target, response, body, signal, extractHtml, allowEmptyContent);
    }

    return documentFromDecoded(target, response, body, signal, extractHtml, allowEmptyContent);
  }

  return documentFromResponse(target, response, signal, extractHtml, allowEmptyContent);
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
  allowEmptyContent = false,
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

  // Cookies live only for this acquisition; challenge handshakes never persist or
  // cross into another fetch.
  const requestDependencies: FetchRemoteDependencies = {
    ...dependencies,
    cookies: dependencies.cookies ?? new CookieJar(),
  };

  try {
    const requestUrl = normalizeGitHubRawUrl(rawUrl);

    let { target, response } = await requestFollowingRedirects(
      requestUrl,
      controller.signal,
      requestDependencies,
      conditionalHeaders,
    );

    // Some servers route Markdown negotiation to a missing representation even
    // though their HTML page exists (for example, Redis documentation URLs).
    // Retry only these representation-related statuses, through the same
    // validated redirect/network boundary, with HTML preferred.
    if ([404, 406].includes(response.statusCode ?? 0)) {
      response.resume();
      ({ target, response } = await requestFollowingRedirects(
        target.url,
        controller.signal,
        requestDependencies,
        { Accept: "text/html, text/plain;q=0.9, */*;q=0.1" },
      ));
    }

    if (
      response.statusCode !== undefined &&
      responseHeader(response, "cf-mitigated")?.trim().toLowerCase() === "challenge"
    ) {
      const fallbackUrl = npmRegistryFallbackUrl(rawUrl);

      if (fallbackUrl) {
        response.resume();
        ({ target, response } = await requestFollowingRedirects(
          fallbackUrl,
          controller.signal,
          requestDependencies,
        ));
      }
    }

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
      document: await documentFromAcquisition(
        target,
        response,
        controller.signal,
        extractHtml,
        allowEmptyContent,
        requestDependencies,
        true,
      ),
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
  allowEmptyContent = false,
): Promise<CompleteDocument> {
  return (await fetchDocument(rawUrl, signal, dependencies, undefined, allowEmptyContent)).document;
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
