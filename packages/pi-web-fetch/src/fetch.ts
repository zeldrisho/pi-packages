import type { IncomingMessage } from "node:http";
import { awaitWithAbort } from "./abort";
import { sliceCompleteDocument, type CompleteDocument, type FetchResult } from "./content";
import { diagnoseExtraction, extractDocumentLinks, hasExtractionWarning } from "./evidence";
import { extractHtmlToMarkdown } from "./extract";
import { requestFollowingRedirects, type RedirectDependencies } from "./network-redirects";
import type { ValidatedTarget } from "./network-policy";
import {
  decodeResponse,
  FETCH_MAX_BYTES,
  readResponseBytes,
  responseHeader,
} from "./network-transport";

/**
 * Rewrites GitHub source URLs to their raw counterparts so file contents are fetched as
 * clean plain text instead of Defuddle's noisy rendered view:
 *
 * - `github.com` `blob` URLs become their `raw.githubusercontent.com` counterpart.
 * - Bare gist pages (`gist.github.com/<user>/<id>`) get `/raw` appended; the redirect to
 *   `gist.githubusercontent.com` is followed by the normal redirect policy.
 *
 * @param rawUrl - The URL to normalize
 * @returns The rewritten raw URL, or the input unchanged for non-GitHub and non-source URLs
 */
export function normalizeGitHubRawUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:") return rawUrl;
    if (url.hostname === "github.com") {
      if (url.pathname.includes("/blob/")) {
        return `https://raw.githubusercontent.com${url.pathname.replace("/blob/", "/")}${url.search}`;
      }
      // Parse pathname segments: /owner/repo/tree/ref/path
      const segments = url.pathname.split("/").filter(Boolean);
      if (segments.length >= 4 && segments[2] === "tree") {
        const lastSegment = segments[segments.length - 1];
        if (lastSegment.includes(".")) {
          // Reconstruct path: /owner/repo/ref/path (remove "tree" segment)
          const newPath = `/${segments[0]}/${segments[1]}/${segments.slice(3).join("/")}`;
          return `https://raw.githubusercontent.com${newPath}${url.search}`;
        }
        return rawUrl;
      }
      return rawUrl;
    }
    if (url.hostname === "gist.github.com") {
      const segments = url.pathname.split("/").filter(Boolean);
      // Only rewrite bare gist pages. Subpages such as `/revisions`, `/forks`, or an
      // explicit `/raw` path already point at a usable resource and stay untouched.
      if (segments.length !== 2) return rawUrl;
      return `https://gist.github.com/${segments[0]}/${segments[1]}/raw${url.search}`;
    }
    return rawUrl;
  } catch {
    return rawUrl;
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

/**
 * Parses an HTTP `Link:` header for the agent-discovery link relations defined by
 * llmstxt.org v2: `rel="describedby"` (the covering `llms.txt`) and
 * `rel="alternate" type="text/markdown"` (the Markdown version of the resource).
 *
 * @param header - The raw `Link:` header value
 * @param baseUrl - URL used to resolve relative references
 * @returns The first advertised target of each relation, when present
 */
export function parseLinkHeaderForAgentHints(
  header: string,
  baseUrl: string | URL,
): LinkHeaderAgentHints {
  // Split on commas outside <...> and quoted strings, since URIs and quoted values may
  // themselves contain commas.
  const directives: string[] = [];
  let current = "";
  let inQuotes = false;
  let inAngleBrackets = false;
  for (const character of header) {
    if (character === '"') inQuotes = !inQuotes;
    if (character === "<") inAngleBrackets = true;
    if (character === ">" && !inQuotes) inAngleBrackets = false;
    if (character === "," && !inQuotes && !inAngleBrackets) {
      directives.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  directives.push(current);

  let describedBy: string | undefined;
  let markdownAlternate: string | undefined;
  for (const directive of directives) {
    const match = /^\s*<([^>]*)>\s*(.*)$/.exec(directive);
    if (!match) continue;
    const [, rawTarget, rawParameters] = match;
    const parameters = new Map<string, string>();
    for (const parameter of rawParameters.split(";")) {
      const equals = parameter.indexOf("=");
      if (equals === -1) continue;
      const key = parameter.slice(0, equals).trim().toLowerCase();
      const value = parameter
        .slice(equals + 1)
        .trim()
        .replace(/^"|"$/g, "");
      parameters.set(key, value);
    }
    const relations = (parameters.get("rel") ?? "").toLowerCase().split(/\s+/);
    const type = (parameters.get("type") ?? "").toLowerCase();
    let resolved: string | undefined;
    try {
      resolved = new URL(rawTarget.trim(), baseUrl).href;
    } catch {
      continue;
    }
    if (!resolved) continue;
    if (!describedBy && relations.includes("describedby")) describedBy = resolved;
    if (!markdownAlternate && relations.includes("alternate") && type === "text/markdown") {
      markdownAlternate = resolved;
    }
  }
  return { describedBy, markdownAlternate };
}

export interface FetchRemoteDependencies extends RedirectDependencies {
  extractHtml?: typeof extractHtmlToMarkdown;
  timeoutMs?: number;
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

  const contentTypeHeader = responseHeader(response, "content-type") ?? "text/plain";
  const contentType = contentTypeHeader.split(";", 1)[0].trim().toLowerCase();
  const linkHints = parseLinkHeaderForAgentHints(
    responseHeader(response, "link") ?? "",
    target.url,
  );
  const allowed =
    contentType.startsWith("text/") ||
    [
      "application/json",
      "application/markdown",
      "application/x-markdown",
      "application/xml",
      "application/xhtml+xml",
    ].includes(contentType);
  if (!allowed) {
    response.destroy();
    throw new Error(`web_fetch does not support ${contentType || "this content type"}.`);
  }

  const raw = decodeResponse(
    await readResponseBytes(response, FETCH_MAX_BYTES, signal),
    contentTypeHeader,
  );
  let markdown: string;
  let title: string | undefined;
  let extractor: CompleteDocument["extractor"] = "raw";
  let describedBy: string | undefined = linkHints.describedBy;
  let markdownAlternateUrl: string | undefined = linkHints.markdownAlternate;
  if (contentType === "text/html" || contentType === "application/xhtml+xml") {
    const extracted = await awaitWithAbort(extractHtml(raw, target.url), signal);
    markdown = extracted.markdown;
    title = extracted.title;
    extractor = extracted.extractor;
    describedBy = describedBy ?? extracted.describedByLink;
    markdownAlternateUrl = markdownAlternateUrl ?? extracted.markdownAlternateLink;
  } else if (contentType === "application/json") {
    try {
      markdown = `\`\`\`json\n${JSON.stringify(JSON.parse(raw), null, 2)}\n\`\`\``;
    } catch {
      markdown = raw;
    }
  } else markdown = raw.trim();

  const isHtml = contentType === "text/html" || contentType === "application/xhtml+xml";
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
    title,
    extractor,
    shellSuspected,
    extractionDiagnostics,
    links: isHtml ? extractDocumentLinks(raw, target.url) : undefined,
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
    throw new Error(`Invalid URL: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`web_fetch only supports http(s) URLs: ${value}`);
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
