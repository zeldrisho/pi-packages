import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { formatSize } from "@earendil-works/pi-coding-agent";
import type { ValidatedTarget } from "./network-policy";

export const FETCH_MAX_BYTES = 5 * 1_024 * 1_024;

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

export async function requestPinned(
  target: ValidatedTarget,
  signal: AbortSignal,
): Promise<IncomingMessage> {
  const lookup: LookupFunction = (_hostname, options, callback) => {
    if (options.all) callback(null, [{ address: target.address, family: target.family }]);
    else callback(null, target.address, target.family);
  };
  const request = target.url.protocol === "https:" ? httpsRequest : httpRequest;
  return await new Promise((resolve, reject) => {
    const outgoing = request(
      target.url,
      {
        lookup,
        signal,
        headers: {
          Accept: "text/markdown, text/html, text/plain, application/json;q=0.9, */*;q=0.1",
          "User-Agent": "Mozilla/5.0 (compatible; PiWebFetch/1.0; +https://pi.dev)",
        },
      },
      resolve,
    );
    outgoing.once("error", reject);
    outgoing.end();
  });
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
