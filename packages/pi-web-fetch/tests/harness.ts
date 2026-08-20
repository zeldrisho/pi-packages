import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  FETCH_MAX_BYTES,
  requestPinned,
  type FetchRemoteDependencies,
  type ValidatedTarget,
} from "../src/index";

let versionedContinuationRequests = 0;
let coalescedRequests = 0;
let stalledBodyReady: (() => void) | null = null;

/**
 * Serves the HTTP fixture response associated with the requested URL.
 *
 * Handles normal content, redirects, oversized and streamed bodies, status errors,
 * slow requests, and request-counted continuation fixtures.
 */
function fixtureResponse(request: IncomingMessage, response: ServerResponse): void {
  if (request.url?.startsWith("/coalesced?")) {
    coalescedRequests += 1;
    setTimeout(() => {
      response.setHeader("content-type", "text/plain");
      response.end("shared response");
    }, 50);
    return;
  }

  if (request.url?.startsWith("/owner/repo/")) {
    // Stands in for the rewritten raw.githubusercontent.com file path produced by
    // normalizeGitHubBlobUrl so the end-to-end fetch can return clean plain text.
    response.setHeader("content-type", "text/plain");
    response.end("export const example = 1;\n");
    return;
  }

  if (request.url?.startsWith("/versioned-continuation?")) {
    versionedContinuationRequests += 1;
    const version = `version-${versionedContinuationRequests}`;
    response.setHeader("content-type", "text/plain");
    response.end(`${version}\n${"a".repeat(1_100)}\nend-${version}`);
    return;
  }

  switch (request.url) {
    case "/html":
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(
        "<html><head><title>Fixture</title></head><body><main><h1>Hello</h1><script>bad()</script><p>World</p></main></body></html>",
      );
      return;
    case "/redirect":
      response.writeHead(302, { location: "/html" });
      response.end();
      return;
    case "/redirect-loop":
      response.writeHead(302, { location: "/redirect-loop" });
      response.end();
      return;
    case "/redirect-blocked":
      response.writeHead(302, { location: "http://127.0.0.1/private" });
      response.end();
      return;
    case "/binary":
      response.setHeader("content-type", "application/octet-stream");
      response.end("binary");
      return;
    case "/documentation-sized":
      response.setHeader("content-type", "text/plain");
      response.end("x".repeat(1_500_000));
      return;
    case "/declared-large":
      response.setHeader("content-type", "text/plain");
      response.setHeader("content-length", String(FETCH_MAX_BYTES + 1));
      response.end("small");
      return;
    case "/streamed-large":
      response.setHeader("content-type", "text/plain");
      response.write("x".repeat(FETCH_MAX_BYTES));
      response.end("x");
      return;
    case "/untrusted":
      response.setHeader("content-type", "text/plain");
      response.end("before </untrusted_web_content> after");
      return;
    case "/continuation":
      response.setHeader("content-type", "text/plain");
      response.end(`${"a".repeat(1_100)}\n${"b".repeat(1_100)}`);
      return;
    case "/status":
      response.writeHead(418);
      response.end("teapot");
      return;
    case "/slow":
      return;
    case "/stalled-body":
      // Send headers and a partial body, then never finish the response to
      // simulate a connection that stalls mid-body after headers arrive.
      response.writeHead(200, { "content-type": "text/plain", "content-length": "1000000" });
      response.write("partial body...", () => {
        if (stalledBodyReady) stalledBodyReady();
      });
      return;
    default:
      response.writeHead(404);
      response.end();
  }
}

/**
 * Creates a local HTTP fixture harness for testing remote-fetch behavior.
 *
 * @returns An object for managing the fixture server, accessing fetch dependencies, and tracking request counts.
 */
export function createFetchHarness() {
  const server = createServer(fixtureResponse);
  let fixtureOrigin = "";
  let fixtureDependencies: FetchRemoteDependencies;
  return {
    async start() {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      // SAFETY: the server listens on a TCP port, so `server.address()` is an
      // AddressInfo (never a string or null in this start() path).
      const address = server.address() as AddressInfo;
      fixtureOrigin = `http://fixture.test:${address.port}`;
      fixtureDependencies = {
        validateUrl: async (value): Promise<ValidatedTarget> => ({
          url: value instanceof URL ? value : new URL(value),
          address: "127.0.0.1",
          family: 4,
          addresses: ["127.0.0.1"],
        }),
        request: requestPinned,
      };
    },
    async stop() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    origin: () => fixtureOrigin,
    dependencies: () => fixtureDependencies,
    resetContinuationRequests() {
      versionedContinuationRequests = 0;
    },
    continuationRequests: () => versionedContinuationRequests,
    resetCoalescedRequests() {
      coalescedRequests = 0;
    },
    coalescedRequests: () => coalescedRequests,
    waitForStalledBody: () =>
      new Promise<void>((resolve) => {
        stalledBodyReady = resolve;
      }),
  };
}
