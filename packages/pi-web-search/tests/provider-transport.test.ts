import { describe, expect, it, vi } from "vite-plus/test";
import { searchBraveWeb } from "../src/brave";
import {
  SEARCH_WEB_MAX_QUERY_CHARACTERS,
  SEARCH_MAX_RESULT_COUNT,
  SEARCH_MIN_RESULT_COUNT,
} from "../src/limits";
import { createSearchTool, jsonResponse } from "./harness";

describe("web_search provider transport", () => {
  it("rejects fractional and out-of-range provider result counts", async () => {
    for (const count of [SEARCH_MIN_RESULT_COUNT - 1, SEARCH_MAX_RESULT_COUNT + 1, 1.5]) {
      await expect
        .soft(
          searchBraveWeb("query", count, undefined, undefined, "transport-secret"),
          String(count),
        )
        .rejects.toThrow("Search result count must be an integer");
    }
  });

  it("rejects Answers queries beyond the tool limit", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "context-secret";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      createSearchTool().execute(
        "call",
        { query: "x".repeat(SEARCH_WEB_MAX_QUERY_CHARACTERS + 1), mode: "answers" },
        undefined,
        undefined,
      ),
    ).rejects.toThrow(`cannot exceed ${SEARCH_WEB_MAX_QUERY_CHARACTERS} characters`);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects oversized declared bodies even if cancelling the stream fails", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "declared-cancel-secret";

    const cancel = vi.fn(async () => {
      throw new Error("cancel failed");
    });

    const body = new ReadableStream<Uint8Array>({ cancel });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(body, {
            headers: { "content-length": "2000001", "content-type": "application/json" },
          }),
      ),
    );

    await expect(
      createSearchTool().execute("call", { query: "declared cancel test" }, undefined, undefined),
    ).rejects.toThrow("Search provider response is too large.");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("enforces the cumulative streamed byte limit even if cancelling fails", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "streamed-oversize-secret";

    const cancel = vi.fn(async () => {
      throw new Error("cancel failed");
    });

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1_000_001).fill(0x20));
        controller.enqueue(new Uint8Array(1_000_000).fill(0x20));
      },
      cancel,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { headers: { "content-type": "application/json" } })),
    );

    await expect(
      createSearchTool().execute("call", { query: "streamed oversize test" }, undefined, undefined),
    ).rejects.toThrow("Search provider response is too large.");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("preserves the HTTP status when an error body cannot be read", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "unreadable-error-secret";

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("body failed"));
      },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 502 })),
    );

    await expect(
      createSearchTool().execute("call", { query: "unreadable error test" }, undefined, undefined),
    ).rejects.toThrow("Provider returned HTTP 502");
  });

  it("does not expose provider error bodies or echoed credentials", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "error-secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(`<b>error-secret ${"failure ".repeat(100)}</b>`, { status: 429 }),
      ),
    );
    await expect(
      createSearchTool().execute("call", { query: "provider error test" }, undefined, undefined),
    ).rejects.toThrow(/^Provider returned HTTP 429$/);
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
        (error_: any) => error_,
      );

    expect(error).toBeInstanceOf(Error);
    // SAFETY: the rejection value is always an Error thrown by the provider transport.
    const err = error as Error;
    expect(err.message).toBe("Provider returned HTTP 429");
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

    const expectation = expect(pending).rejects.toThrow("Timed out after 20 seconds");
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
    await expect(pending).rejects.toThrow("Cancelled.");
  });
});
