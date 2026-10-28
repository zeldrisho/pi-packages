import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import {
  fetchRemoteContent,
  isAwsWafChallengeResponse,
  requestPinned,
  type FetchRemoteDependencies,
} from "../src/index";

/** Starts a loopback HTTP server and returns its base URL and cleanup function. */
async function listen(handler: RequestListener) {
  const server = createServer(handler);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  // SAFETY: the server has successfully listened on a TCP port above.
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("AWS WAF challenge detection", () => {
  it("accepts challenge headers and ignores missing or unrelated actions", () => {
    expect(isAwsWafChallengeResponse({ headers: { "x-amzn-waf-action": " Challenge " } })).toBe(
      true,
    );
    expect(
      isAwsWafChallengeResponse({ headers: { "x-amzn-waf-action": ["challenge", "other"] } }),
    ).toBe(true);
    expect(isAwsWafChallengeResponse({ headers: { "x-amzn-waf-action": "block" } })).toBe(false);
    expect(isAwsWafChallengeResponse({ headers: {} })).toBe(false);
  });
});

describe("AWS WAF acquisition", () => {
  let page: Awaited<ReturnType<typeof listen>>;
  let pageUrl: string;
  let baseDependencies: FetchRemoteDependencies;

  beforeAll(async () => {
    page = await listen((request, response) => {
      if (request.url === "/llms.txt") {
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("Not Found");

        return;
      }

      if (request.url === "/page") {
        if (request.headers.cookie?.includes("aws-waf-token=solved:token")) {
          response.setHeader("content-type", "text/plain");
          response.end("WAF-resolved content");

          return;
        }

        response.writeHead(202, {
          "content-type": "text/html",
          "x-amzn-waf-action": "challenge",
        });
        response.end("challenge");

        return;
      }

      response.writeHead(404);
      response.end();
    });

    pageUrl = `${page.url}/page`;
    baseDependencies = {
      validateUrl: async (value) => {
        const url = value instanceof URL ? value : new URL(value);

        return { url, address: "127.0.0.1", family: 4, addresses: ["127.0.0.1"] };
      },
      request: (target, signal, headers) => requestPinned(target, signal, { headers }),
    };
  });

  afterAll(async () => {
    await page.close();
  });

  it("retries once with the resolved token and does not reuse it across fetches", async () => {
    const requests: string[] = [];

    const dependencies: FetchRemoteDependencies = {
      ...baseDependencies,
      awsWafResolver: {
        async resolve(context) {
          requests.push(context.url.href);

          return { token: "solved:token" };
        },
      },
    };

    const first = await fetchRemoteContent(pageUrl, 0, 6_000, undefined, dependencies);
    const second = await fetchRemoteContent(pageUrl, 0, 6_000, undefined, dependencies);

    expect(first.markdown).toContain("WAF-resolved content");
    expect(second.markdown).toContain("WAF-resolved content");
    expect(requests).toEqual([pageUrl, pageUrl]);
  });

  it("falls back to the normal blocked result when the resolver returns no token", async () => {
    let calls = 0;

    await expect(
      fetchRemoteContent(pageUrl, 0, 6_000, undefined, {
        ...baseDependencies,
        awsWafResolver: {
          async resolve() {
            calls += 1;

            return undefined;
          },
        },
      }),
    ).rejects.toThrow("blocked by an AWS WAF anti-bot challenge (HTTP 202)");
    expect(calls).toBe(1);
  });

  it("does not resolve when AWS WAF solving is disabled for a probe", async () => {
    let calls = 0;

    await expect(
      fetchRemoteContent(pageUrl, 0, 6_000, undefined, {
        ...baseDependencies,
        solveAwsWafChallenges: false,
        awsWafResolver: {
          async resolve() {
            calls += 1;

            return { token: "solved:token" };
          },
        },
      }),
    ).rejects.toThrow("blocked by an AWS WAF anti-bot challenge (HTTP 202)");
    expect(calls).toBe(0);
  });
});
