import type { IncomingMessage } from "node:http";
import { awaitWithAbort } from "./abort";
import { sliceCompleteDocument, type CompleteDocument, type FetchResult } from "./content";
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
 * Rewrites a GitHub `blob` URL to its raw counterpart so file contents are fetched as
 * clean plain text instead of Defuddle's noisy code-rendering table.
 *
 * @param rawUrl - The URL to normalize
 * @returns The rewritten raw URL, or the input unchanged for non-GitHub and non-blob URLs
 */
export function normalizeGitHubBlobUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || url.hostname !== "github.com") return rawUrl;
    if (!url.pathname.includes("/blob/")) return rawUrl;
    return `https://raw.githubusercontent.com${url.pathname.replace("/blob/", "/")}${url.search}`;
  } catch {
    return rawUrl;
  }
}

const APP_SHELL_MARKERS = [
  /please\s+enable\s+javascript/i,
  /enable\s+javascript/i,
  /consent/i,
  /are\s+you\s+a\s+robot/i,
  /verify\s+you\s+are\s+human/i,
  /checking\s+your\s+browser/i,
  /<title>\s*just\s+a\s+moment/i,
];

/**
 * Detects pages that are likely app shells, bot walls, or consent interstitials rather than
 * readable content.
 *
 * @param raw - The raw response body
 * @param markdown - The extracted Markdown
 * @returns True when the extracted text is suspiciously sparse relative to the raw page
 */
export function detectAppShell(raw: string, markdown: string): boolean {
  if (APP_SHELL_MARKERS.some((marker) => marker.test(raw))) return true;
  return raw.length > 4000 && markdown.length < raw.length * 0.015;
}

const REQUEST_TIMEOUT_MS = 20_000;

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
  if (contentType === "text/html" || contentType === "application/xhtml+xml") {
    const extracted = await awaitWithAbort(extractHtml(raw, target.url), signal);
    markdown = extracted.markdown;
    title = extracted.title;
    extractor = extracted.extractor;
  } else if (contentType === "application/json") {
    try {
      markdown = `\`\`\`json\n${JSON.stringify(JSON.parse(raw), null, 2)}\n\`\`\``;
    } catch {
      markdown = raw;
    }
  } else markdown = raw.trim();

  const shellSuspected =
    contentType === "text/html" || contentType === "application/xhtml+xml"
      ? detectAppShell(raw, markdown)
      : false;

  return {
    url: target.url.toString(),
    contentType,
    markdown: markdown.replace(/<\/untrusted_web_content>/gi, "&lt;/untrusted_web_content&gt;"),
    title,
    extractor,
    shellSuspected,
  };
}

export async function fetchCompleteDocument(
  rawUrl: string,
  signal: AbortSignal | undefined,
  dependencies: FetchRemoteDependencies,
): Promise<CompleteDocument> {
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

  try {
    const { target, response } = await requestFollowingRedirects(
      normalizeGitHubBlobUrl(rawUrl),
      controller.signal,
      {
        validateUrl: dependencies.validateUrl,
        request: dependencies.request,
      },
    );
    return await documentFromResponse(target, response, controller.signal, extractHtml);
  } catch (error) {
    if (timedOut) throw new Error(`web_fetch timed out after ${timeoutMs / 1000} seconds.`);
    if (signal?.aborted) throw new Error("web_fetch was cancelled.");
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", cancel);
  }
}

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
