import { describe, expect, it, vi } from "vite-plus/test";
import { createSearchTool, jsonResponse } from "./harness";

describe("web_search caching coalescing", () => {
  it("caches identical requests without caching secrets", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "cache-secret";
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        web: {
          results: [{ title: "Cached", url: "https://example.com", description: "value" }],
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const tool = createSearchTool();
    const params = { query: "unique cache query 914", count: 1 };
    const updates: string[] = [];

    const first = await tool.execute("first", params, undefined, (update) =>
      updates.push(update.content[0].text),
    );
    const second = await tool.execute("second", params, undefined, (update) =>
      updates.push(update.content[0].text),
    );

    expect(first.details.cached).toBe(false);
    expect(second.details.cached).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(second)).not.toContain("cache-secret");
    expect(updates).toEqual(["Searching the web with brave (web)…", "Using cached brave results…"]);
  });

  it("coalesces concurrent searches without letting one caller cancel another", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "coalesce-secret";
    let resolveResponse: (response: Response) => void = () => {};
    let sharedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) =>
        await new Promise<Response>((resolve) => {
          sharedSignal = init?.signal ?? undefined;
          resolveResponse = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const tool = createSearchTool();
    const controller = new AbortController();
    const params = { query: "unique concurrent query 318", count: 1 };

    const cancelled = tool.execute("first", params, controller.signal, undefined);
    const completed = tool.execute("second", params, undefined, undefined);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const cancelledExpectation = expect(cancelled).rejects.toThrow("cancelled");
    controller.abort();
    resolveResponse(
      jsonResponse({
        web: { results: [{ title: "Shared", url: "https://example.com/shared" }] },
      }),
    );

    await cancelledExpectation;
    await expect(completed).resolves.toMatchObject({ details: { resultCount: 1 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sharedSignal?.aborted).toBe(false);
  });
});
