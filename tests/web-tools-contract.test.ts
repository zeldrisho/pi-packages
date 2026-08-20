import { readFile } from "node:fs/promises";
import { type IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { executeWebFetch, type ValidatedTarget } from "../packages/pi-web-fetch/src/index";
import { SearchRuntime } from "../packages/pi-web-search/src/index";

function textResponse(body: string): IncomingMessage {
  // SAFETY: Readable.from yields the exact byte stream an IncomingMessage provides;
  // we attach statusCode and headers immediately afterward.
  const response = Readable.from([body]) as IncomingMessage;
  response.statusCode = 200;
  response.headers = { "content-type": "text/plain; charset=utf-8" };
  return response;
}

function expectCommonTruncationContract(
  details: { truncated: boolean; strategy: string },
  topLevelTruncated: boolean,
): void {
  expect(details).toEqual(
    expect.objectContaining({
      truncated: expect.any(Boolean),
      strategy: expect.stringMatching(/^(continuation|temporary-file|none)$/),
    }),
  );
  expect(details.truncated).toBe(topLevelTruncated);
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.BRAVE_SEARCH_API_KEY;
});

describe("web tool truncation contract", () => {
  it("keeps locally implemented recovery metadata compatible", async () => {
    const fetchResult = await executeWebFetch(
      { url: "https://fetch-contract.example/page", maxCharacters: 1_000 },
      undefined,
      undefined,
      {
        validateUrl: async (value): Promise<ValidatedTarget> => ({
          url: value instanceof URL ? value : new URL(value),
          address: "93.184.216.34",
          family: 4,
        }),
        request: async () => textResponse("x".repeat(2_000)),
      },
    );

    expectCommonTruncationContract(fetchResult.details.truncation, fetchResult.details.truncated);
    expect(fetchResult.details.truncation).toEqual({
      truncated: true,
      strategy: "continuation",
      nextOffset: 1_000,
    });
    expect(fetchResult.details.nextOffset).toBe(fetchResult.details.truncation.nextOffset);

    process.env.BRAVE_SEARCH_API_KEY = "contract-secret";
    const generic = Array.from({ length: 20 }, (_, index) => ({
      title: `Contract result ${index}`,
      url: `https://search-contract.example/${index}`,
      snippets: ["a".repeat(8_000), "b".repeat(8_000), "c".repeat(8_000)],
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ grounding: { generic } }), {
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    const runtime = new SearchRuntime();
    try {
      const searchResult = await runtime.execute(
        { query: "repository truncation contract", mode: "context", count: 20 },
        undefined,
        undefined,
      );
      expectCommonTruncationContract(
        searchResult.details.truncation,
        searchResult.details.truncated,
      );
      const truncation = searchResult.details.truncation;
      expect(truncation.strategy).toBe("temporary-file");
      expect(truncation.fullOutputPath).toBe(searchResult.details.fullOutputPath);
      const fullOutput = await readFile(truncation.fullOutputPath!, "utf8");
      expect(truncation.totalBytes).toBe(new TextEncoder().encode(fullOutput).byteLength);
      expect(truncation.totalLines).toBe(fullOutput.split("\n").length);
      expect(truncation.outputBytes).toBeLessThan(truncation.totalBytes);
      expect(truncation.outputLines).toBeLessThanOrEqual(truncation.totalLines);
    } finally {
      await runtime.shutdown();
    }
  });
});
