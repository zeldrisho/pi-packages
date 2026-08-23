import { describe, expect, it, vi } from "vite-plus/test";
import { searchBraveWeb } from "../src/brave";
import {
  SEARCH_CONTEXT_MAX_QUERY_CHARACTERS,
  SEARCH_MAX_RESULT_COUNT,
  SEARCH_MIN_RESULT_COUNT,
} from "../src/limits";
import { createSearchTool, jsonResponse } from "./harness";

describe("web_search provider transport", () => {
  it.each([SEARCH_MIN_RESULT_COUNT - 1, SEARCH_MAX_RESULT_COUNT + 1, 1.5])(
    "rejects invalid provider result counts (%s)",
    async (count) => {
      await expect(
        searchBraveWeb("query", count, undefined, undefined, undefined, "transport-secret"),
      ).rejects.toThrow("Search result count must be an integer");
    },
  );

  it("uses only Brave's context endpoint without fetching result URLs", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "context-only-secret";
    const resultUrl = "https://example.com/provider-result";
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({
        grounding: {
          generic: [{ title: "Provider context", url: resultUrl, snippets: ["Extracted"] }],
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await createSearchTool().execute(
      "call",
      {
        query: "provider-only context",
        mode: "context",
        freshness: "day",
        language: "en",
      },
      undefined,
      undefined,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const input = fetchMock.mock.calls[0][0];
    const requestedUrl = new URL(input instanceof Request ? input.url : input.toString());
    expect(requestedUrl.origin + requestedUrl.pathname).toBe(
      "https://api.search.brave.com/res/v1/llm/context",
    );
    expect(requestedUrl.searchParams.get("freshness")).toBe("pd");
    expect(requestedUrl.searchParams.get("search_lang")).toBe("en");
    expect(requestedUrl.toString()).not.toContain(resultUrl);
  });

  it("rejects context queries beyond the provider limit", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "context-secret";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      createSearchTool().execute(
        "call",
        { query: "x".repeat(SEARCH_CONTEXT_MAX_QUERY_CHARACTERS + 1), mode: "context" },
        undefined,
        undefined,
      ),
    ).rejects.toThrow(`cannot exceed ${SEARCH_CONTEXT_MAX_QUERY_CHARACTERS} characters`);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects successful responses with an oversized declared content length", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "declared-oversize-secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("{}", {
            headers: { "content-length": "2000001", "content-type": "application/json" },
          }),
      ),
    );

    await expect(
      createSearchTool().execute("call", { query: "declared oversize test" }, undefined, undefined),
    ).rejects.toThrow("Search provider response is too large.");
  });

  it("rejects successful streamed responses that exceed the byte limit", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "streamed-oversize-secret";
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1_000_001).fill(0x20));
        controller.enqueue(new Uint8Array(1_000_000).fill(0x20));
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { headers: { "content-type": "application/json" } })),
    );

    await expect(
      createSearchTool().execute("call", { query: "streamed oversize test" }, undefined, undefined),
    ).rejects.toThrow("Search provider response is too large.");
    expect(cancelled).toBe(true);
  });

  it("bounds provider error bodies and strips markup", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "error-secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(`<b>${"failure ".repeat(100)}</b>`, { status: 429 })),
    );
    await expect(
      createSearchTool().execute("call", { query: "provider error test" }, undefined, undefined),
    ).rejects.toThrow(/^Search provider returned HTTP 429: failure/);
  });

  it("stops reading oversized provider errors while preserving the HTTP status", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "large-error-secret";
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`<b>${"failure ".repeat(1_200)}`));
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 429 })),
    );

    const error = await createSearchTool()
      .execute("call", { query: "oversized provider error test" }, undefined, undefined)
      .then(
        () => undefined,
        (reason: any) => reason,
      );

    expect(error).toBeInstanceOf(Error);
    // SAFETY: the rejection value is always an Error thrown by the provider transport.
    const err = error as Error;
    expect(err.message).toMatch(/^Search provider returned HTTP 429: failure/);
    expect(err.message).not.toContain("<b>");
    expect(err.message.length).toBeLessThan(550);
    expect(cancelled).toBe(true);
  });

  it("reports provider timeouts", async () => {
    vi.useFakeTimers();
    process.env.BRAVE_SEARCH_API_KEY = "timeout-secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        await new Promise<void>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
        return jsonResponse({});
      }),
    );
    const pending = createSearchTool().execute(
      "call",
      { query: "timeout query" },
      undefined,
      undefined,
    );
    const expectation = expect(pending).rejects.toThrow("timed out after 20 seconds");
    await vi.advanceTimersByTimeAsync(20_000);
    await expectation;
  });

  it("reports caller cancellation", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "cancel-secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        await new Promise<void>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
        return jsonResponse({});
      }),
    );
    const controller = new AbortController();
    const pending = createSearchTool().execute(
      "call",
      { query: "cancel query" },
      controller.signal,
      undefined,
    );
    controller.abort();
    await expect(pending).rejects.toThrow("cancelled");
  });
});
