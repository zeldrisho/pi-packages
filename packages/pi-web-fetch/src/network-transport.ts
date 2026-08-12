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
 * Pins a request to one of the target's validated addresses, trying each
 * address in order while the connection phase is still in flight.
 *
 * DNS-to-address pinning is preserved: only addresses resolved and validated
 * by {@link validateRemoteUrl} are ever contacted, and each connection attempt
 * is bounded so a hanging address cannot exhaust the overall request timeout.
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
