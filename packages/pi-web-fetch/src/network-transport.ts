import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { formatSize } from "@earendil-works/pi-coding-agent";
import type { ValidatedTarget } from "./network-policy";

export const FETCH_MAX_BYTES = 5 * 1_024 * 1_024;

/**
 * Per-address connect deadline. A hanging address is abandoned after this
 * budget so the next validated address can be tried inside the overall
 * request timeout.
 */
export const CONNECT_ATTEMPT_TIMEOUT_MS = 4_000;

const encoder = new TextEncoder();

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
): Promise<IncomingMessage> {
  const family = isIP(address);
  if (family !== 4 && family !== 6) throw new Error(`web_fetch could not resolve ${address}.`);
  const lookup: LookupFunction = (_hostname, options, callback) => {
    if (options.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
  const request = target.url.protocol === "https:" ? httpsRequest : httpRequest;
  return await new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), attemptTimeoutMs);
    const forwardAbort = () => controller.abort();
    signal.addEventListener("abort", forwardAbort, { once: true });
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", forwardAbort);
      callback();
    };
    const outgoing = request(
      target.url,
      {
        lookup,
        signal: controller.signal,
        headers: {
          Accept: "text/markdown, text/html, text/plain, application/json;q=0.9, */*;q=0.1",
          "User-Agent": "Mozilla/5.0 (compatible; PiWebFetch/1.0; +https://pi.dev)",
        },
      },
      (response) => {
        if (controller.signal.aborted) {
          // The attempt deadline fired before response headers: drop the socket
          // and treat the address as unreachable so the next one is tried.
          response.destroy();
          finish(() =>
            reject(
              new Error(`web_fetch could not reach ${address} within ${attemptTimeoutMs} ms.`),
            ),
          );
        } else finish(() => resolve(response));
      },
    );
    outgoing.once("error", (error) => finish(() => reject(error)));
    outgoing.end();
  });
}

export interface RequestPinnedOptions {
  /** Per-address connect deadline used to fall back to the next address. */
  attemptTimeoutMs?: number;
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
      return await requestOnce(target, address, signal, attemptTimeoutMs);
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

export async function readResponseBytes(
  response: IncomingMessage,
  maxBytes: number,
): Promise<Uint8Array> {
  const declared = Number(responseHeader(response, "content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    response.destroy();
    throw new Error(responseTooLargeMessage(declared, maxBytes, true));
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const value of response) {
    const chunk = typeof value === "string" ? encoder.encode(value) : new Uint8Array(value);
    total += chunk.byteLength;
    if (total > maxBytes) {
      response.destroy();
      throw new Error(responseTooLargeMessage(total, maxBytes, false));
    }
    chunks.push(chunk);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export function decodeResponse(bytes: Uint8Array, contentTypeHeader: string): string {
  const charset = contentTypeHeader.match(/(?:^|;)\s*charset\s*=\s*["']?([^;"'\s]+)/i)?.[1];
  try {
    return new TextDecoder(charset || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}
