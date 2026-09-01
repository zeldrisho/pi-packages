import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { formatSize } from "@earendil-works/pi-coding-agent";
import type { ValidatedTarget } from "./network-policy";

/** Maximum size in bytes for raw HTTP response bodies. */
export const FETCH_MAX_BYTES = 5 * 1_024 * 1_024;

/**
 * Per-address connect deadline. A hanging address is abandoned after this
 * budget so the next validated address can be tried inside the overall
 * request timeout.
 */
export const CONNECT_ATTEMPT_TIMEOUT_MS = 4_000;

const encoder = new TextEncoder();

/** Builds an AbortError matching the DOMException name used by the abort signal. */
function abortedError(): Error {
  const error = new Error("Operation aborted.");
  error.name = "AbortError";
  return error;
}

/**
 * Formats an error message for a response that exceeds the raw download limit.
 *
 * @param receivedBytes - The number of bytes received or reported by the response.
 * @param maxBytes - The maximum allowed number of bytes.
 * @param sizeIsExact - Whether `receivedBytes` is the exact response size.
 * @returns A message describing the response size and configured limit.
 */
function responseTooLargeMessage(
  receivedBytes: number,
  maxBytes: number,
  sizeIsExact: boolean,
): string {
  const size = sizeIsExact
    ? `is ${formatSize(receivedBytes)}`
    : `has reached at least ${formatSize(receivedBytes)}`;
  return [
    `web_fetch response ${size}, exceeding the ${formatSize(maxBytes)} raw download limit.`,
    "maxCharacters only controls returned output.",
  ].join(" ");
}

/**
 * Sends a request to a specific validated network address.
 *
 * @param target - The validated request target.
 * @param address - The IPv4 or IPv6 address to use for the connection.
 * @param signal - Signal used to cancel the request.
 * @param attemptTimeoutMs - Maximum time allowed for the connection attempt.
 * @returns The received response.
 * @throws If `address` is not a valid IPv4 or IPv6 address.
 */
async function requestOnce(
  target: ValidatedTarget,
  address: string,
  signal: AbortSignal,
  attemptTimeoutMs: number,
  headers: Readonly<Record<string, string>>,
): Promise<IncomingMessage> {
  const family = isIP(address);
  if (family !== 4 && family !== 6) throw new Error(`web_fetch could not resolve ${address}.`);
  const lookup: LookupFunction = (_hostname, options, callback) => {
    // Match dns.lookup's asynchronous callback contract. Calling back inline
    // lets an immediately unreachable address emit a socket error before
    // node:http has finished installing its forwarding listeners.
    queueMicrotask(() => {
      if (options.all) callback(null, [{ address, family }]);
      else callback(null, address, family);
    });
  };
  const request = target.url.protocol === "https:" ? httpsRequest : httpRequest;
  return await new Promise((resolve, reject) => {
    const controller = new AbortController();
    let attemptExpired = false;
    const timer = setTimeout(() => {
      attemptExpired = true;
      controller.abort();
    }, attemptTimeoutMs);
    const forwardAbort = () => controller.abort();
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", forwardAbort, { once: true });
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", forwardAbort);
      callback();
    };
    const unreachableError = () =>
      new Error(`web_fetch could not reach ${address} within ${attemptTimeoutMs} ms.`);
    const outgoing = request(
      target.url,
      {
        lookup,
        signal: controller.signal,
        headers: {
          Accept: "text/markdown, text/html, text/plain, application/json;q=0.9, */*;q=0.1",
          "User-Agent": "Mozilla/5.0 (compatible; PiWebFetch/1.0; +https://pi.dev)",
          ...headers,
        },
      },
      (response) => {
        if (controller.signal.aborted) {
          // The attempt deadline or caller cancellation fired before response
          // headers: drop the socket and report the reason.
          response.destroy();
          finish(() => reject(attemptExpired ? unreachableError() : abortedError()));
        } else finish(() => resolve(response));
      },
    );
    outgoing.once("error", (error) => {
      // The per-attempt deadline surfaces as a raw AbortError from the HTTP
      // client; report it as an unreachable address instead so the next
      // validated address is tried and the final error explains itself.
      if (attemptExpired) finish(() => reject(unreachableError()));
      else finish(() => reject(error));
    });
    outgoing.end();
  });
}

export interface RequestPinnedOptions {
  /** Per-address connect deadline used to fall back to the next address. */
  attemptTimeoutMs?: number;
  /** Additional fixed request headers, used for conditional cache revalidation. */
  headers?: Readonly<Record<string, string>>;
}

/**
 * Sends a request to the target using its validated addresses in sequence.
 *
 * @param options - Optional settings for individual connection attempts.
 * @param options.attemptTimeoutMs - Maximum time allowed for each connection attempt in milliseconds.
 * @returns The first successful HTTP response.
 * @throws The final connection error if all addresses fail, or the abort error if the signal is aborted.
 */
export async function requestPinned(
  target: ValidatedTarget,
  signal: AbortSignal,
  options: RequestPinnedOptions = {},
): Promise<IncomingMessage> {
  const attemptTimeoutMs = options.attemptTimeoutMs ?? CONNECT_ATTEMPT_TIMEOUT_MS;
  const addresses = target.addresses?.length ? target.addresses : [target.address];
  let lastError: unknown;
  for (const address of addresses) {
    try {
      return await requestOnce(target, address, signal, attemptTimeoutMs, options.headers ?? {});
    } catch (error) {
      lastError = error;
      if (signal.aborted) throw error;
    }
  }
  throw lastError ?? new Error("web_fetch could not connect.");
}

/**
 * Retrieves a response header value by name.
 *
 * @param response - The response containing the header
 * @param name - The header name to retrieve
 * @returns The first header value, or `undefined` when the header is absent
 */
export function responseHeader(response: IncomingMessage, name: string): string | undefined {
  const value = response.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Read and buffer the complete response body.
 *
 * Enforces the maximum byte limit and respects abort signals during the read.
 * Destroys the response stream if limits are exceeded or abort is signaled.
 *
 * @param response - HTTP response to read
 * @param maxBytes - Maximum allowed response size in bytes
 * @param signal - Optional abort signal to cancel the read
 * @returns Buffered response body as bytes
 * @throws When response exceeds maxBytes or abort signal fires
 */
export async function readResponseBytes(
  response: IncomingMessage,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const declared = Number(responseHeader(response, "content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    response.destroy();
    throw new Error(responseTooLargeMessage(declared, maxBytes, true));
  }
  // Once response headers arrive the connect deadline and caller signal are no
  // longer wired to the socket, so a stalled body would otherwise hang the
  // fetch forever. Keep the caller signal attached for the whole body read and
  // drop the socket when it fires.
  const forwardAbort = () => response.destroy();
  if (signal?.aborted) response.destroy();
  else signal?.addEventListener("abort", forwardAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const value of response) {
      const chunk = value instanceof Uint8Array ? value : encoder.encode(value);
      total += chunk.byteLength;
      if (total > maxBytes) {
        response.destroy();
        throw new Error(responseTooLargeMessage(total, maxBytes, false));
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (signal?.aborted) throw abortedError();
    throw error;
  } finally {
    signal?.removeEventListener("abort", forwardAbort);
  }
  // Destroying the socket can end the stream without an error; detect a
  // mid-read abort here as well so truncated bodies never look complete.
  if (signal?.aborted) throw abortedError();
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

/**
 * Decode HTTP response bytes to a string using the charset from Content-Type.
 *
 * Extracts the charset parameter from the Content-Type header and uses it
 * to decode the response. Falls back to UTF-8 if charset is missing or invalid.
 *
 * @param bytes - Raw response bytes to decode
 * @param contentTypeHeader - Value of the Content-Type response header
 * @returns Decoded response string
 */
export function decodeResponse(bytes: Uint8Array, contentTypeHeader: string): string {
  const charset = contentTypeHeader.match(/(?:^|;)\s*charset\s*=\s*["']?([^;"'\s]+)/i)?.[1];
  try {
    return new TextDecoder(charset || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}
