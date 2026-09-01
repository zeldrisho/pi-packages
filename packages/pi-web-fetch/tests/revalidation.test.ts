import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { executeWebFetch, type FetchRemoteDependencies, type ValidatedTarget } from "../src/index";

function response(
  statusCode: number,
  body = "",
  headers: Record<string, string> = {},
): IncomingMessage {
  const bytes = Buffer.from(body);
  // SAFETY: Fetch tests use only these response fields and the supplied async stream contract.
  return {
    statusCode,
    headers,
    resume() {},
    destroy() {},
    async *[Symbol.asyncIterator]() {
      if (bytes.length > 0) yield bytes;
    },
  } as IncomingMessage;
}

describe("stale cache revalidation", () => {
  afterEach(() => vi.useRealTimers());

  it("revalidates through the pinned transport with ETag and Last-Modified", async () => {
    const startedAt = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(startedAt);
    const url = `https://raw.githubusercontent.com/example/project/main/revalidate-${process.pid}-${Math.random()}.txt`;
    const requestHeaders: Array<Readonly<Record<string, string>> | undefined> = [];
    let requests = 0;
    const dependencies: FetchRemoteDependencies = {
      validateUrl: async (value): Promise<ValidatedTarget> => ({
        url: value instanceof URL ? value : new URL(value),
        address: "203.0.113.10",
        family: 4,
      }),
      request: async (_target, _signal, headers) => {
        requestHeaders.push(headers);
        requests += 1;
        return requests === 1
          ? response(200, "cached representation", {
              "content-type": "text/plain",
              etag: '"version-1"',
              "last-modified": "Wed, 31 Dec 2025 12:00:00 GMT",
            })
          : response(304, "", { etag: '"version-1"' });
      },
    };

    const first = await executeWebFetch({ url }, undefined, undefined, dependencies);
    expect(first.details.cacheStatus).toBe("miss");

    vi.setSystemTime(startedAt + 24 * 60 * 60 * 1_000 + 1);
    const second = await executeWebFetch({ url }, undefined, undefined, dependencies);

    expect(second.details.cacheStatus).toBe("revalidated");
    expect(second.details.cached).toBe(true);
    expect(second.content[0].text).toContain("cached representation");
    expect(requestHeaders[1]).toMatchObject({
      "If-None-Match": '"version-1"',
      "If-Modified-Since": "Wed, 31 Dec 2025 12:00:00 GMT",
    });
  });

  it("distinguishes fresh hits from cache misses", async () => {
    const startedAt = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(startedAt);
    const url = `https://raw.githubusercontent.com/example/project/main/hit-${process.pid}-${Math.random()}.txt`;
    const dependencies: FetchRemoteDependencies = {
      validateUrl: async (value) => ({
        url: value instanceof URL ? value : new URL(value),
        address: "203.0.113.10",
        family: 4,
      }),
      request: async () => response(200, "fresh representation", { "content-type": "text/plain" }),
    };
    const miss = await executeWebFetch({ url }, undefined, undefined, dependencies);
    const hit = await executeWebFetch({ url }, undefined, undefined, dependencies);
    expect(miss.details.cacheStatus).toBe("miss");
    expect(hit.details.cacheStatus).toBe("hit");
  });
});
