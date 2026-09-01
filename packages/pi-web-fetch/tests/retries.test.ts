// oxlint-disable anti-slop/no-chained-type-assertions
import type { IncomingMessage } from "node:http";
import { describe, expect, it, vi } from "vite-plus/test";
import { requestFollowingRedirects } from "../src/network-redirects";
import type { ValidatedTarget } from "../src/network-policy";

function response(statusCode: number, headers: Record<string, string> = {}): IncomingMessage {
  // SAFETY: Redirect tests only inspect statusCode/headers and close responses; this fixture supplies that contract.
  return {
    statusCode,
    headers,
    resume: vi.fn(),
    destroy: vi.fn(),
  } as unknown as IncomingMessage;
}

const target = (value: string | URL): ValidatedTarget => ({
  url: value instanceof URL ? value : new URL(value),
  address: "203.0.113.10",
  family: 4,
});

describe("origin coordination and retries", () => {
  it("uses the default abortable backoff timer", async () => {
    vi.useFakeTimers();
    try {
      const statuses = [429, 200];
      const pending = requestFollowingRedirects(
        "https://timer.example.com/resource",
        new AbortController().signal,
        {
          validateUrl: async (value) => target(value),
          request: async () => response(statuses.shift()!),
          random: () => 1,
        },
      );
      await vi.waitFor(() => expect(statuses).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(313);
      await expect(pending).resolves.toMatchObject({ response: { statusCode: 200 } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels the default retry timer", async () => {
    const controller = new AbortController();
    let requests = 0;
    const pending = requestFollowingRedirects(
      "https://timer-cancel.example.com/resource",
      controller.signal,
      {
        validateUrl: async (value) => target(value),
        request: async () => {
          requests += 1;
          return response(429);
        },
      },
    );
    await vi.waitFor(() => expect(requests).toBe(1));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("honors Retry-After before retrying 429 and 503 responses", async () => {
    const statuses = [429, 503, 200];
    const delays: number[] = [];
    const result = await requestFollowingRedirects(
      "https://example.com/resource",
      new AbortController().signal,
      {
        validateUrl: async (value) => target(value),
        request: async () => response(statuses.shift()!, { "retry-after": "2" }),
        sleep: async (milliseconds) => {
          delays.push(milliseconds);
        },
        random: () => 0,
      },
    );
    expect(result.response.statusCode).toBe(200);
    expect(delays).toEqual([2_000, 2_000]);
  });

  it("parses and bounds an HTTP-date Retry-After value", async () => {
    const statuses = [503, 200];
    const delays: number[] = [];
    await requestFollowingRedirects(
      "https://date.example.com/resource",
      new AbortController().signal,
      {
        validateUrl: async (value) => target(value),
        request: async () =>
          response(statuses.shift()!, {
            "retry-after": new Date(Date.now() + 60_000).toUTCString(),
          }),
        sleep: async (milliseconds) => {
          delays.push(milliseconds);
        },
      },
    );
    expect(delays).toEqual([10_000]);
  });

  it("bounds jittered backoff and stops after two retries", async () => {
    const delays: number[] = [];
    let requests = 0;
    const result = await requestFollowingRedirects(
      "https://backoff.example.com/resource",
      new AbortController().signal,
      {
        validateUrl: async (value) => target(value),
        request: async () => {
          requests += 1;
          return response(503);
        },
        sleep: async (milliseconds) => {
          delays.push(milliseconds);
        },
        random: () => 1,
      },
    );
    expect(result.response.statusCode).toBe(503);
    expect(requests).toBe(3);
    expect(delays).toEqual([313, 625]);
  });

  it("preserves caller cancellation during retry delays", async () => {
    const controller = new AbortController();
    let sleeping!: () => void;
    const pending = requestFollowingRedirects(
      "https://cancel.example.com/resource",
      controller.signal,
      {
        validateUrl: async (value) => target(value),
        request: async () => response(429),
        sleep: async (_milliseconds, signal) =>
          new Promise<void>((_resolve, reject) => {
            const cancel = () => reject(new Error("cancelled retry"));
            signal.addEventListener("abort", cancel, { once: true });
            sleeping = () => signal.removeEventListener("abort", cancel);
          }),
      },
    );
    await vi.waitFor(() => expect(sleeping).toBeTypeOf("function"));
    controller.abort();
    await expect(pending).rejects.toThrow("cancelled retry");
    sleeping();
  });

  it("cancels a caller while it waits for an origin slot", async () => {
    const releases: Array<() => void> = [];
    const request = async (): Promise<IncomingMessage> => {
      await new Promise<void>((resolve) => releases.push(resolve));
      return response(200);
    };
    const dependencies = { validateUrl: async (value: string | URL) => target(value), request };
    const blockers = Array.from({ length: 4 }, (_, index) =>
      requestFollowingRedirects(
        `https://queued.example.com/blocker-${index}`,
        new AbortController().signal,
        dependencies,
      ),
    );
    await vi.waitFor(() => expect(releases).toHaveLength(4));
    const controller = new AbortController();
    const queued = requestFollowingRedirects(
      "https://queued.example.com/queued",
      controller.signal,
      dependencies,
    );
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    releases.splice(0).forEach((release) => release());
    await Promise.all(blockers);
  });

  it("reserves a released origin slot for the queued waiter", async () => {
    let active = 0;
    let maximum = 0;
    const releases: Array<() => void> = [];
    const request = async (): Promise<IncomingMessage> => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return response(200);
    };
    const dependencies = { validateUrl: async (value: string | URL) => target(value), request };
    const blockers = Array.from({ length: 4 }, (_, index) =>
      requestFollowingRedirects(
        `https://reserved.example.com/blocker-${index}`,
        new AbortController().signal,
        dependencies,
      ),
    );
    await vi.waitFor(() => expect(releases).toHaveLength(4));
    const queued = requestFollowingRedirects(
      "https://reserved.example.com/queued",
      new AbortController().signal,
      dependencies,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    releases.shift()?.();
    const newcomer = requestFollowingRedirects(
      "https://reserved.example.com/newcomer",
      new AbortController().signal,
      dependencies,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(maximum).toBe(4);
    while (releases.length > 0) {
      releases.splice(0).forEach((release) => release());
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await Promise.all([...blockers, queued, newcomer]);
  });

  it("limits concurrent request starts per origin", async () => {
    let active = 0;
    let maximum = 0;
    const releases: Array<() => void> = [];
    const request = async (): Promise<IncomingMessage> => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return response(200);
    };
    const calls = Array.from({ length: 6 }, (_, index) =>
      requestFollowingRedirects(
        `https://limited.example.com/resource-${index}`,
        new AbortController().signal,
        { validateUrl: async (value) => target(value), request },
      ),
    );
    await vi.waitFor(() => expect(releases).toHaveLength(4));
    releases.splice(0, 4).forEach((release) => release());
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases.splice(0).forEach((release) => release());
    await Promise.all(calls);
    expect(maximum).toBe(4);
  });
});
