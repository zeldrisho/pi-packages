import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { fetchGeminiMetadata, parsePiCatalog, restorePiSnapshots } from "../src/pi-catalog";

const model = {
  id: "gemini-3.8-flash",
  type: "chat",
  reasoning: true,
  input: ["text", "image"],
  contextWindow: 100_000,
  maxTokens: 10_000,
  thinkingLevelMap: {
    off: null,
    minimal: null,
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: null,
    max: null,
  },
};

afterEach(() => vi.unstubAllGlobals());

describe("pi.dev Gemini metadata", () => {
  it("validates remote entries and ignores irrelevant or malformed data", () => {
    expect(parsePiCatalog([model])?.get(model.id)).toEqual({
      levels: ["low", "medium", "high"],
      input: ["text", "image"],
      contextWindow: 100_000,
      maxTokens: 10_000,
    });
    expect(
      parsePiCatalog([
        { ...model, contextWindow: -1 },
        { ...model, thinkingLevelMap: { low: 42 } },
        { ...model, id: "other" },
      ])?.size,
    ).toBe(0);
    expect(parsePiCatalog({})).toBeUndefined();
  });
  it("fetches both public endpoints without credentials and prefers Google", async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      requests.push({ url, init });

      return Response.json(
        [{ ...model, contextWindow: url.includes("google-vertex") ? 200_000 : 100_000 }],
        { headers: { "last-modified": "Wed, 21 Oct 2099 07:28:00 GMT" } },
      );
    });
    const result = await fetchGeminiMetadata(new AbortController().signal);
    expect(result.models.get(model.id)?.contextWindow).toBe(100_000);
    expect(requests.map(({ url }) => url)).toEqual([
      "https://pi.dev/api/models/providers/google?types=chat",
      "https://pi.dev/api/models/providers/google-vertex?types=chat",
    ]);

    for (const { init } of requests) {
      expect(init.redirect).toBe("error");
      expect(new Headers(init.headers).has("authorization")).toBe(false);
    }
  });
  it("does not override a newer bundled catalog with stale remote metadata", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json([model], { headers: { "last-modified": "Wed, 21 Oct 2015 07:28:00 GMT" } }),
    );
    const result = await fetchGeminiMetadata(new AbortController().signal);
    expect(result.completed).toBe(true);
    expect(result.models.get(model.id)?.contextWindow).toBe(1_048_576);
    expect(result.snapshots.google?.entries).toHaveLength(1);
  });
  it("falls back to bundled metadata on bad, oversized, or unavailable responses", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response("x", { headers: { "content-length": "3000000" } }),
    );
    expect(
      (await fetchGeminiMetadata(new AbortController().signal)).models.get(model.id)?.contextWindow,
    ).toBe(1_048_576);
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline");
    });
    expect(
      (await fetchGeminiMetadata(new AbortController().signal)).models.get(model.id)?.contextWindow,
    ).toBe(1_048_576);
  });
  it("bounds streamed bodies even when content-length is missing", async () => {
    const cancel = vi.fn();
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
            },
            cancel,
          }),
        ),
    );
    expect(
      (await fetchGeminiMetadata(new AbortController().signal)).models.get(model.id)?.contextWindow,
    ).toBe(1_048_576);
    expect(cancel).toHaveBeenCalledTimes(2);
  });
  it("revalidates cached bodies independently and retains them on HTTP failure", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json([model], {
        headers: { etag: '"v1"', "last-modified": "Wed, 21 Oct 2099 07:28:00 GMT" },
      }),
    );
    const first = await fetchGeminiMetadata(new AbortController().signal);
    expect(first.completed).toBe(true);
    expect(first.snapshots.google?.etag).toBe('"v1"');
    const headers: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      headers.push(new Headers(init.headers).get("if-none-match") ?? "");

      return url.includes("google-vertex")
        ? new Response(null, { status: 503 })
        : new Response(null, { status: 304 });
    });
    const second = await fetchGeminiMetadata(new AbortController().signal, first.snapshots);
    expect(headers).toEqual(['"v1"', '"v1"']);
    expect(second.completed).toBe(true);
    expect(second.models.get(model.id)?.contextWindow).toBe(100_000);
    expect(second.snapshots).toEqual(first.snapshots);
  });
  it("does not trust invalid cached validators and records unavailable catalogs", async () => {
    expect(
      restorePiSnapshots({ google: { entries: [model], lastModified: 0, etag: "bad\nheader" } })
        .google,
    ).toBeUndefined();
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      expect(new Headers(init.headers).has("if-none-match")).toBe(false);

      return new Response(null, { status: 404 });
    });
    const result = await fetchGeminiMetadata(new AbortController().signal);
    expect(result.completed).toBe(true);
    expect(result.snapshots.google).toEqual({ entries: [], lastModified: 0 });
  });
  it("preserves caller cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal("fetch", async () => {
      throw new Error("aborted");
    });
    await expect(fetchGeminiMetadata(controller.signal)).rejects.toThrow("aborted");
  });
});
