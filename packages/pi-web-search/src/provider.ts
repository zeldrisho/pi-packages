const REQUEST_TIMEOUT_MS = 20_000;

const SEARCH_MAX_RESPONSE_BYTES = 2_000_000;

/**
 * Normalizes text by removing HTML tags, collapsing whitespace, and truncating to a maximum length.
 *
 * @param value - The text to normalize
 * @param maxLength - Maximum length of the normalized text
 * @returns Normalized text, truncated with ellipsis if needed
 */
export function normalizeText(value: string, maxLength: number): string {
  if (maxLength <= 0) return "";

  const text = value
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

/**
 * Reads response body bytes with size limits.
 *
 * @param response - HTTP response to read
 * @param maxBytes - Maximum bytes to read
 * @returns Promise resolving to the response bytes
 * @throws {Error} When response exceeds maxBytes
 */
async function readResponseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  const declared = contentLength === null ? Number.NaN : Number(contentLength);

  if (Number.isFinite(declared) && declared > maxBytes && declared > 0) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Search provider response is too large.");
  }

  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) break;
      const remaining = maxBytes - total;

      if (value.byteLength > remaining) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Search provider response is too large.");
      }

      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const output = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return output;
}

/**
 * Reads and decodes response body as UTF-8 text with size limits.
 *
 * @param response - HTTP response to read
 * @param maxBytes - Maximum bytes to read
 * @returns Promise resolving to the decoded text
 * @throws {Error} When response exceeds maxBytes and truncate is false
 */
async function readResponseText(response: Response, maxBytes: number): Promise<string> {
  return new TextDecoder().decode(await readResponseBytes(response, maxBytes));
}

/**
 * Performs an HTTP request and reads bounded text with timeout and size limits.
 *
 * @param url - URL to request
 * @param init - Fetch request init options
 * @param signal - Optional abort signal for cancellation
 * @returns Promise resolving to the bounded response text
 * @throws {Error} When request times out, is cancelled, or response is too large
 */
export async function requestText(
  url: string | URL,
  init: RequestInit,
  signal: AbortSignal | undefined,
): Promise<string> {
  const controller = new AbortController();
  let timedOut = false;

  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });

  if (signal?.aborted) controller.abort();

  try {
    // Custom subscription-token headers are not stripped by fetch on cross-origin
    // redirects. Never follow a provider-controlled redirect with credentials.
    const response = await fetch(url, { ...init, redirect: "error", signal: controller.signal });

    if (!response.ok) {
      // Error bodies are untrusted and can echo credentials or private queries.
      void response.body?.cancel().catch(() => undefined);
      throw new Error(`Provider returned HTTP ${response.status}`);
    }

    return await readResponseText(response, SEARCH_MAX_RESPONSE_BYTES);
  } catch (error) {
    if (timedOut) throw new Error(`Timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds.`);

    if (signal?.aborted) throw new Error("Cancelled.");
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", cancel);
  }
}

/** Uses the shared bounded transport to decode a provider JSON response. */
export async function requestJson<T>(
  url: string | URL,
  init: RequestInit,
  signal: AbortSignal | undefined,
): Promise<T> {
  // SAFETY: callers supply the expected provider shape; transport bounds the decoded document.
  return JSON.parse(await requestText(url, init, signal)) as T;
}
