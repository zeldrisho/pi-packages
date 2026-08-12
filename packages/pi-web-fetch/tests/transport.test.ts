import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createServer } from "node:http";
import { fetchRemoteContent, requestPinned, type FetchRemoteDependencies } from "../src/index";
import { createFetchHarness } from "./harness";

describe("web_fetch transport", () => {
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

  it("extracts HTML while removing executable content", async () => {
    const result = await fetchRemoteContent(`${origin}/html`, 0, 6_000, undefined, dependencies);
    expect(result.markdown).toContain("Hello");
    expect(result.markdown).toContain("World");
    expect(result.markdown).not.toContain("bad()");
    expect(result.title).toBe("Fixture");
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
});
