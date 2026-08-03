import type { IncomingMessage } from "node:http";
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

const REQUEST_TIMEOUT_MS = 20_000;

export interface FetchRemoteDependencies extends RedirectDependencies {
  extractHtml?: typeof extractHtmlToMarkdown;
  timeoutMs?: number;
}

function awaitWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      callback();
    };
    const abort = (): void => {
      const error = new Error("Operation aborted.");
      error.name = "AbortError";
      finish(() => reject(error));
    };

    operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

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

  const raw = decodeResponse(await readResponseBytes(response, FETCH_MAX_BYTES), contentTypeHeader);
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

  return {
    url: target.url.toString(),
    contentType,
    markdown: markdown.replace(/<\/untrusted_web_content>/gi, "&lt;/untrusted_web_content&gt;"),
    title,
    extractor,
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
    const { target, response } = await requestFollowingRedirects(rawUrl, controller.signal, {
      validateUrl: dependencies.validateUrl,
      request: dependencies.request,
    });
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
