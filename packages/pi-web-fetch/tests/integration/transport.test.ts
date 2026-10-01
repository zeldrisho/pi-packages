import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createServer, type IncomingMessage } from "node:http";
import {
  fetchRemoteContent,
  npmRegistryFallbackUrl,
  requestPinned,
  type FetchRemoteDependencies,
} from "../../src/index";
import { createFetchHarness } from "./harness";

function fixtureResponse(
  statusCode: number,
  headers: Record<string, string>,
  body: string,
): IncomingMessage {
  const bytes = Buffer.from(body);

  // SAFETY: This fixture supplies the status, headers, stream, and cleanup methods used by fetch.
  return {
    statusCode,
    headers,
    resume() {},
    destroy() {},
    async *[Symbol.asyncIterator]() {
      yield bytes;
    },
  } as IncomingMessage;
}

describe("web_fetch transport", () => {
  it("maps npm package pages to the public registry latest endpoint", () => {
    expect(npmRegistryFallbackUrl("https://www.npmjs.com/package/cf")).toBe(
      "https://registry.npmjs.org/cf/latest",
    );
    expect(npmRegistryFallbackUrl("https://www.npmjs.com/package/@scope/name")).toBe(
      "https://registry.npmjs.org/@scope/name/latest",
    );
    expect(npmRegistryFallbackUrl("https://www.npmjs.com/package/cf/v/1.0.0")).toBeUndefined();
    expect(npmRegistryFallbackUrl("https://npmjs.com/package/cf")).toBeUndefined();
  });
  const fixture = createFetchHarness();
  let origin = "";
  let dependencies: FetchRemoteDependencies;

  beforeAll(async () => {
    await fixture.start();
    origin = fixture.origin();
    dependencies = fixture.dependencies();
  });

  afterAll(async () => {
    await fixture.stop();
  });

  it.each(["/empty", "/empty-html"])(
    "reports empty document content clearly for %s",
    async (path) => {
      await expect(
        fetchRemoteContent(`${origin}${path}`, 0, 6_000, undefined, dependencies),
      ).rejects.toThrow("web_fetch: Page has no extractable content.");
    },
  );

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

  it("falls back to the next validated address when the first is refused", async () => {
    const response = await requestPinned(
      {
        url: new URL(`http://refused-test.invalid:${new URL(origin).port}/html`),
        address: "127.0.0.2",
        family: 4,
        addresses: ["127.0.0.2", "127.0.0.1"],
      },
      new AbortController().signal,
    );

    expect(response.statusCode).toBe(200);
    response.resume();
  });

  it("abandons a hanging address and falls back inside the connect deadline", async () => {
    // Accept connections on a second loopback address without sending response
    // headers, so the first attempt deterministically hangs until its deadline.
    // The URL uses a unique hostname so the keep-alive agent does not reuse a
    // socket pooled under the fixture origin; the pinned lookup resolves it.
    const fixturePort = new URL(origin).port;
    const hanging = createServer(() => {});
    await new Promise<void>((resolve, reject) => {
      hanging.once("error", reject);
      hanging.listen(Number(fixturePort), "127.0.0.2", resolve);
    });

    try {
      const started = Date.now();

      const response = await requestPinned(
        {
          url: new URL(`http://hanging-test.invalid:${fixturePort}/html`),
          address: "127.0.0.2",
          family: 4,
          addresses: ["127.0.0.2", "127.0.0.1"],
        },
        new AbortController().signal,
        { attemptTimeoutMs: 300 },
      );

      expect(response.statusCode).toBe(200);
      // The first (hanging) address must have burned its connect deadline.
      expect(Date.now() - started).toBeGreaterThanOrEqual(300);
      response.resume();
    } finally {
      hanging.closeAllConnections();
      await new Promise<void>((resolve) => hanging.close(() => resolve()));
    }
  });

  it("reports the connect deadline as an unreachable address", async () => {
    // A single hanging address must fail with the friendly deadline message
    // instead of leaking the HTTP client's raw AbortError to the caller.
    const fixturePort = new URL(origin).port;
    const hanging = createServer(() => {});
    await new Promise<void>((resolve, reject) => {
      hanging.once("error", reject);
      hanging.listen(Number(fixturePort), "127.0.0.2", resolve);
    });

    try {
      await expect(
        requestPinned(
          {
            url: new URL(`http://hanging-only-test.invalid:${fixturePort}/html`),
            address: "127.0.0.2",
            family: 4,
            addresses: ["127.0.0.2"],
          },
          new AbortController().signal,
          { attemptTimeoutMs: 300 },
        ),
      ).rejects.toThrow("web_fetch could not reach 127.0.0.2 within 300 ms.");
    } finally {
      hanging.closeAllConnections();
      await new Promise<void>((resolve) => hanging.close(() => resolve()));
    }
  });

  it("cancels the attempt when the caller signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      requestPinned(
        {
          url: new URL(`${origin}/html`),
          address: "127.0.0.1",
          family: 4,
          addresses: ["127.0.0.1"],
        },
        controller.signal,
      ),
    ).rejects.toThrow();
  });

  it("contains immediate connection failures under concurrent load", async () => {
    const attempts = Array.from({ length: 100 }, () =>
      requestPinned(
        {
          url: new URL("https://unreachable-test.invalid/"),
          address: "2001:db8::1",
          family: 6,
          addresses: ["2001:db8::1"],
        },
        new AbortController().signal,
        { attemptTimeoutMs: 50 },
      ),
    );

    const outcomes = await Promise.allSettled(attempts);
    expect(outcomes).toHaveLength(100);
    expect(outcomes.every((outcome) => outcome.status === "rejected")).toBe(true);
  });

  it("extracts HTML while removing executable content", async () => {
    const result = await fetchRemoteContent(`${origin}/html`, 0, 6_000, undefined, dependencies);
    expect(result.markdown).toContain("Hello");
    expect(result.markdown).toContain("World");
    expect(result.markdown).not.toContain("bad()");
    expect(result.title).toBe("Fixture");
  });

  it("extracts HTML when the server repeats an equivalent media type", async () => {
    const result = await fetchRemoteContent(
      `${origin}/duplicated-html-type`,
      0,
      6_000,
      undefined,
      dependencies,
    );

    expect(result.markdown).toContain("Recovered");
    expect(result.markdown).not.toContain("<html>");
  });

  it("rejects conflicting media types instead of guessing the representation", async () => {
    await expect(
      fetchRemoteContent(`${origin}/conflicting-types`, 0, 6_000, undefined, dependencies),
    ).rejects.toThrow("does not support text/html, text/plain");
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

  it("falls back to the npm registry when a package page is Cloudflare-challenged", async () => {
    const packageName = `fetch-fallback-${process.pid}`;
    const packagePage = `https://www.npmjs.com/package/${packageName}`;
    const registryUrl = `https://registry.npmjs.org/${packageName}/latest`;
    const requests: string[] = [];

    const fallbackDependencies: FetchRemoteDependencies = {
      validateUrl: async (value) => {
        const url = value instanceof URL ? value : new URL(value);

        return { url, address: "127.0.0.1", family: 4, addresses: ["127.0.0.1"] };
      },
      request: async (target) => {
        requests.push(target.url.href);

        if (target.url.href === packagePage) {
          return fixtureResponse(
            403,
            { "content-type": "text/html", "cf-mitigated": "challenge" },
            "Cloudflare challenge",
          );
        }

        if (target.url.href === registryUrl) {
          return fixtureResponse(
            200,
            { "content-type": "application/json" },
            JSON.stringify({ name: packageName, version: "1.2.3" }),
          );
        }

        throw new Error(`Unexpected fixture request: ${target.url.href}`);
      },
    };

    const result = await fetchRemoteContent(packagePage, 0, 6_000, undefined, fallbackDependencies);

    expect(requests).toEqual([packagePage, registryUrl]);
    expect(result.markdown).toContain(`"name": "${packageName}"`);
    expect(result.markdown).toContain('"version": "1.2.3"');
  });

  it("returns the Cloudflare-specific error for non-npm challenge responses", async () => {
    await expect(
      fetchRemoteContent(`${origin}/cloudflare-challenge`, 0, 6_000, undefined, dependencies),
    ).rejects.toThrow(/blocked by Cloudflare's anti-bot challenge \(HTTP 403\)/);
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
});
