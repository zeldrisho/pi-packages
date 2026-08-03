import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import {
  executeWebFetch,
  FETCH_MAX_BYTES,
  fetchRemoteContent,
  requestPinned,
  validateRemoteUrl,
  type FetchRemoteDependencies,
  type ValidatedTarget,
} from "../src/index";

let versionedContinuationRequests = 0;
let coalescedRequests = 0;

function fixtureResponse(request: IncomingMessage, response: ServerResponse): void {
  if (request.url?.startsWith("/coalesced?")) {
    coalescedRequests += 1;
    setTimeout(() => {
      response.setHeader("content-type", "text/plain");
      response.end("shared response");
    }, 50);
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
    default:
      response.writeHead(404);
      response.end();
  }
}

describe("web_fetch network boundaries", () => {
  const server = createServer(fixtureResponse);
  let origin = "";
  let dependencies: FetchRemoteDependencies;

  beforeAll(async () => {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    origin = `http://fixture.test:${address.port}`;
    dependencies = {
      validateUrl: async (value): Promise<ValidatedTarget> => ({
        url: value instanceof URL ? value : new URL(value),
        address: "127.0.0.1",
        family: 4,
      }),
      request: requestPinned,
    };
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("pins transport requests to the validated address", async () => {
    const response = await requestPinned(
      {
        url: new URL(`${origin}/html`),
        address: "127.0.0.1",
        family: 4,
      },
      new AbortController().signal,
    );
    expect(response.statusCode).toBe(200);
    response.resume();
  });

  it("extracts HTML while removing executable content", async () => {
    const result = await fetchRemoteContent(`${origin}/html`, 0, 6_000, undefined, dependencies);
    expect(result.markdown).toContain("Hello");
    expect(result.markdown).toContain("World");
    expect(result.markdown).not.toContain("bad()");
    expect(result.title).toBe("Fixture");
  });

  it("revalidates and repins every redirect", async () => {
    const validated: string[] = [];
    const requested: ValidatedTarget[] = [];
    const result = await fetchRemoteContent(`${origin}/redirect`, 0, 6_000, undefined, {
      validateUrl: async (value) => {
        const url = value instanceof URL ? value : new URL(value);
        validated.push(url.pathname);
        return { url, address: "127.0.0.1", family: 4 };
      },
      request: async (target, signal) => {
        requested.push(target);
        return await requestPinned(target, signal);
      },
    });
    expect(validated).toEqual(["/redirect", "/html"]);
    expect(requested.map((target) => target.url.pathname)).toEqual(["/redirect", "/html"]);
    expect(requested[1]).not.toBe(requested[0]);
    expect(result.url).toBe(`${origin}/html`);
  });

  it("rejects a redirect to a blocked target before requesting it", async () => {
    const requested: string[] = [];
    await expect(
      fetchRemoteContent(`${origin}/redirect-blocked`, 0, 6_000, undefined, {
        validateUrl: async (value) => {
          const url = value instanceof URL ? value : new URL(value);
          if (url.pathname === "/redirect-blocked") {
            return { url, address: "127.0.0.1", family: 4 };
          }
          return await validateRemoteUrl(url);
        },
        request: async (target, signal) => {
          requested.push(target.url.pathname);
          return await requestPinned(target, signal);
        },
      }),
    ).rejects.toThrow("private or reserved");
    expect(requested).toEqual(["/redirect-blocked"]);
  });

  it("enforces redirect limits", async () => {
    await expect(
      fetchRemoteContent(`${origin}/redirect-loop`, 0, 6_000, undefined, dependencies),
    ).rejects.toThrow("too many redirects");
  });

  it("accepts documentation-sized responses while keeping returned content bounded", async () => {
    const result = await fetchRemoteContent(
      `${origin}/documentation-sized`,
      0,
      6_000,
      undefined,
      dependencies,
    );
    expect(result.nextOffset).toBe(6_000);
    expect(result.markdown).toContain("[Content truncated.");
    expect(result.totalCharacters).toBe(1_500_000);
  });

  it.each([
    ["/binary", "does not support application/octet-stream"],
    ["/status", "HTTP 418"],
  ])("rejects invalid response from %s", async (path, message) => {
    await expect(
      fetchRemoteContent(`${origin}${path}`, 0, 6_000, undefined, dependencies),
    ).rejects.toThrow(message);
  });

  it("explains that a missing page may be private or require authentication", async () => {
    await expect(
      fetchRemoteContent(`${origin}/missing`, 0, 6_000, undefined, dependencies),
    ).rejects.toThrow(/HTTP 404.*page may be missing, private, or require authentication/);
  });

  it.each(["/declared-large", "/streamed-large"])(
    "reports the raw response limit and explains maxCharacters for %s",
    async (path) => {
      await expect(
        fetchRemoteContent(`${origin}${path}`, 0, 6_000, undefined, dependencies),
      ).rejects.toThrow(/raw download limit.*maxCharacters only controls returned output/);
    },
  );

  it("escapes untrusted-content closing tags", async () => {
    const result = await fetchRemoteContent(
      `${origin}/untrusted`,
      0,
      6_000,
      undefined,
      dependencies,
    );
    expect(result.markdown).toContain("&lt;/untrusted_web_content&gt;");
    expect(result.markdown).not.toContain("</untrusted_web_content>");
  });

  it("returns stable continuation offsets", async () => {
    const first = await fetchRemoteContent(
      `${origin}/continuation`,
      0,
      1_000,
      undefined,
      dependencies,
    );
    expect(first.truncated).toBe(true);
    expect(first.nextOffset).toBe(1_000);

    const second = await fetchRemoteContent(
      `${origin}/continuation`,
      first.nextOffset!,
      2_000,
      undefined,
      dependencies,
    );
    expect(second.offset).toBe(1_000);
    expect(second.markdown).toContain("[End of page content.]");
  });

  it("reuses one extracted page across continuation chunks", async () => {
    versionedContinuationRequests = 0;
    const url = `${origin}/versioned-continuation?cache=continuation`;
    const updates: string[] = [];
    const first = await executeWebFetch(
      { url, maxCharacters: 1_000 },
      undefined,
      (update) => updates.push(update.content[0].text),
      dependencies,
    );
    expect(first.details.cached).toBe(false);
    expect(first.details.nextOffset).toBe(1_000);
    expect(first.details.truncation).toEqual({
      truncated: true,
      strategy: "continuation",
      nextOffset: 1_000,
    });
    expect(versionedContinuationRequests).toBe(1);

    const continuation = { url, offset: first.details.nextOffset, maxCharacters: 2_000 };
    const second = await executeWebFetch(
      continuation,
      undefined,
      (update) => updates.push(update.content[0].text),
      dependencies,
    );
    const repeated = await executeWebFetch(continuation, undefined, undefined, dependencies);

    expect(second.details.cached).toBe(true);
    expect(repeated.details.cached).toBe(true);
    expect(versionedContinuationRequests).toBe(1);
    expect(second.content[0].text).toContain("end-version-1");
    expect(second.content[0].text).not.toContain("version-2");
    expect(updates).toEqual([`Fetching ${url}…`, `Using cached content for ${url}…`]);
  });

  it("coalesces concurrent fetches without letting one caller cancel another", async () => {
    coalescedRequests = 0;
    const url = `${origin}/coalesced?request=${Date.now()}`;
    const controller = new AbortController();
    const cancelled = executeWebFetch({ url }, controller.signal, undefined, dependencies);
    const completed = executeWebFetch({ url }, undefined, undefined, dependencies);
    await vi.waitFor(() => expect(coalescedRequests).toBe(1));
    const cancelledExpectation = expect(cancelled).rejects.toThrow("cancelled");
    controller.abort();

    await cancelledExpectation;
    await expect(completed).resolves.toMatchObject({ details: { cached: false } });
    expect(coalescedRequests).toBe(1);
  });

  it("wraps tool output and caches identical requests", async () => {
    const updates: string[] = [];
    const params = { url: `${origin}/html`, maxCharacters: 6_000 };
    const first = await executeWebFetch(
      params,
      undefined,
      (update) => updates.push(update.content[0].text),
      dependencies,
    );
    const second = await executeWebFetch(
      params,
      undefined,
      (update) => updates.push(update.content[0].text),
      dependencies,
    );

    expect(first.details.cached).toBe(false);
    expect(second.details.cached).toBe(true);
    expect(first.content[0].text).toContain("<untrusted_web_content");
    expect(first.content[0].text).toContain("</untrusted_web_content>");
    expect(first.details.truncation).toEqual({
      truncated: false,
      strategy: "none",
      nextOffset: undefined,
    });
    expect(updates).toEqual([`Fetching ${params.url}…`, `Using cached content for ${params.url}…`]);
  });

  it("distinguishes timeout from caller cancellation", async () => {
    await expect(
      fetchRemoteContent(`${origin}/slow`, 0, 6_000, undefined, {
        ...dependencies,
        timeoutMs: 20,
      }),
    ).rejects.toThrow("timed out");

    const controller = new AbortController();
    const pending = fetchRemoteContent(`${origin}/slow`, 0, 6_000, controller.signal, dependencies);
    controller.abort();
    await expect(pending).rejects.toThrow("cancelled");
  });

  it("times out while HTML extraction is stalled", async () => {
    let extractionCount = 0;
    await expect(
      fetchRemoteContent(`${origin}/html`, 0, 6_000, undefined, {
        ...dependencies,
        extractHtml: () => {
          extractionCount += 1;
          return new Promise<never>(() => {});
        },
        timeoutMs: 20,
      }),
    ).rejects.toThrow("web_fetch timed out after 0.02 seconds.");
    expect(extractionCount).toBe(1);
  });

  it("cancels while HTML extraction is stalled", async () => {
    const controller = new AbortController();
    let extractionStarted = false;
    const pending = fetchRemoteContent(`${origin}/html`, 0, 6_000, controller.signal, {
      ...dependencies,
      extractHtml: () => {
        extractionStarted = true;
        return new Promise<never>(() => {});
      },
      timeoutMs: 10_000,
    });

    await vi.waitFor(() => expect(extractionStarted).toBe(true));
    controller.abort();
    await expect(pending).rejects.toThrow("web_fetch was cancelled.");
  });

  it("times out while initial URL validation is stalled", async () => {
    let requestCount = 0;
    await expect(
      fetchRemoteContent("https://example.test", 0, 6_000, undefined, {
        validateUrl: () => new Promise<ValidatedTarget>(() => {}),
        request: async () => {
          requestCount += 1;
          throw new Error("request should not be called");
        },
        timeoutMs: 20,
      }),
    ).rejects.toThrow("web_fetch timed out after 0.02 seconds.");
    expect(requestCount).toBe(0);
  });

  it("cancels while initial URL validation is stalled", async () => {
    const controller = new AbortController();
    let requestCount = 0;
    const pending = fetchRemoteContent("https://example.test", 0, 6_000, controller.signal, {
      validateUrl: () => new Promise<ValidatedTarget>(() => {}),
      request: async () => {
        requestCount += 1;
        throw new Error("request should not be called");
      },
      timeoutMs: 10_000,
    });

    controller.abort();
    await expect(pending).rejects.toThrow("web_fetch was cancelled.");
    expect(requestCount).toBe(0);
  });

  it("times out while redirect URL validation is stalled", async () => {
    const validated: string[] = [];
    await expect(
      fetchRemoteContent(`${origin}/redirect`, 0, 6_000, undefined, {
        ...dependencies,
        validateUrl: async (value) => {
          const url = value instanceof URL ? value : new URL(value);
          validated.push(url.pathname);
          if (url.pathname === "/html") return await new Promise<ValidatedTarget>(() => {});
          return { url, address: "127.0.0.1", family: 4 };
        },
        timeoutMs: 100,
      }),
    ).rejects.toThrow("web_fetch timed out after 0.1 seconds.");
    expect(validated).toEqual(["/redirect", "/html"]);
  });

  it("ignores late validation settlement after cancellation", async () => {
    const controller = new AbortController();
    let resolveValidation: (target: ValidatedTarget) => void = () => {};
    const validation = new Promise<ValidatedTarget>((resolve) => {
      resolveValidation = resolve;
    });
    let requestCount = 0;
    const pending = fetchRemoteContent("https://example.test", 0, 6_000, controller.signal, {
      validateUrl: () => validation,
      request: async () => {
        requestCount += 1;
        throw new Error("request should not be called");
      },
      timeoutMs: 10_000,
    });

    controller.abort();
    await expect(pending).rejects.toThrow("web_fetch was cancelled.");
    resolveValidation({
      url: new URL("https://example.test"),
      address: "93.184.216.34",
      family: 4,
    });
    await validation;
    expect(requestCount).toBe(0);
  });
});
