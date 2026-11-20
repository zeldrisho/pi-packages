import { Agent, request as httpsRequest, type RequestOptions } from "node:https";
import { Readable } from "node:stream";

/** Cipher ordering reported to work with the OpenCode gateway (pi-bansos 0.8.1). */
export const OPENCODE_CIPHERS = [
  "TLS_AES_128_GCM_SHA256",
  "TLS_AES_256_GCM_SHA384",
  "TLS_CHACHA20_POLY1305_SHA256",
  "ECDHE-ECDSA-AES128-GCM-SHA256",
  "ECDHE-RSA-AES128-GCM-SHA256",
  "ECDHE-ECDSA-AES256-GCM-SHA384",
  "ECDHE-RSA-AES256-GCM-SHA384",
  "ECDHE-ECDSA-CHACHA20-POLY1305",
  "ECDHE-RSA-CHACHA20-POLY1305",
].join(":");

/** Fetch-compatible transport with explicit connection cleanup. */
export type InferenceTransport = typeof fetch & { dispose(): void };

/** Uses Node HTTPS only for the fixed inference origin; all other requests use fetch. */
export function createTransport(
  directFetch: typeof fetch = globalThis.fetch,
  send: typeof httpsRequest = httpsRequest,
): InferenceTransport {
  const agent = new Agent({ keepAlive: true, ciphers: OPENCODE_CIPHERS });

  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);

    if (url.origin !== "https://opencode.ai" || !url.pathname.startsWith("/inference/")) {
      return directFetch(input, init);
    }

    const request = new Request(input, init);
    request.signal.throwIfAborted();

    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : Buffer.from(await request.arrayBuffer());

    request.signal.throwIfAborted();
    const headers = new Headers(request.headers);

    for (const name of (headers.get("connection") ?? "").split(",")) {
      if (name.trim()) headers.delete(name.trim());
    }

    for (const name of [
      "host",
      "connection",
      "content-length",
      "keep-alive",
      "proxy-connection",
      "te",
      "trailer",
      "transfer-encoding",
      "upgrade",
    ])
      headers.delete(name);
    headers.set("accept-encoding", "identity");

    if (body) headers.set("content-length", String(body.length));

    return new Promise<Response>((resolve, reject) => {
      const options: RequestOptions = {
        method: request.method,
        headers: Object.fromEntries(headers),
        ciphers: OPENCODE_CIPHERS,
        agent,
        signal: request.signal,
      };

      const outgoing = send(url, options, (incoming) => {
        const responseHeaders = new Headers();

        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) for (const item of value) responseHeaders.append(name, item);
          else if (value !== undefined) responseHeaders.set(name, value);
        }

        const status = incoming.statusCode ?? 502;

        const noBody =
          request.method === "HEAD" || status === 204 || status === 205 || status === 304;

        if (noBody) incoming.resume();
        // SAFETY: IncomingMessage emits Buffer chunks, which are Uint8Array instances.
        const bodyStream = noBody ? null : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>);
        resolve(
          new Response(bodyStream, {
            status,
            statusText: incoming.statusMessage,
            headers: responseHeaders,
          }),
        );
      });

      outgoing.on("error", reject);
      outgoing.end(body);
    });
  };

  return Object.assign(fetcher, { dispose: () => agent.destroy() });
}
