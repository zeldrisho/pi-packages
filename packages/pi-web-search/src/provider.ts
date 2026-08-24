const REQUEST_TIMEOUT_MS = 20_000;
const SEARCH_MAX_RESPONSE_BYTES = 2_000_000;
const SEARCH_ERROR_EXCERPT_BYTES = 8_192;

export function normalizeText(value: string, maxLength: number): string {
  const text = value
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

async function readResponseBytes(
  response: Response,
  maxBytes: number,
  truncate: boolean,
): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  const declared = contentLength === null ? Number.NaN : Number(contentLength);
  if (!truncate && Number.isFinite(declared) && declared > maxBytes && declared > 0) {
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
        if (truncate && remaining > 0) chunks.push(value.subarray(0, remaining));
        await reader.cancel().catch(() => undefined);
        if (truncate) {
          total = maxBytes;
          break;
        }
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

async function readResponseText(
  response: Response,
  maxBytes: number,
  truncate = false,
): Promise<string> {
  return new TextDecoder().decode(await readResponseBytes(response, maxBytes, truncate));
}

export async function requestJson<T>(
  url: string | URL,
  init: RequestInit,
  signal: AbortSignal | undefined,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      let body = "";
      try {
        body = normalizeText(
          await readResponseText(response, SEARCH_ERROR_EXCERPT_BYTES, true),
          500,
        );
      } catch {
        // Preserve the useful HTTP status when an untrusted error body cannot be read.
      }
      throw new Error(`Search provider returned HTTP ${response.status}${body ? `: ${body}` : ""}`);
    }
    // SAFETY: the caller supplies the expected response shape T; JSON.parse yields the decoded document.
    return JSON.parse(await readResponseText(response, SEARCH_MAX_RESPONSE_BYTES)) as T;
  } catch (error) {
    if (timedOut)
      throw new Error(`Web search timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds.`);
    if (signal?.aborted) throw new Error("Web search was cancelled.");
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", cancel);
  }
}
