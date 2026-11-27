import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import {
  fetchRemoteContent,
  type FetchRemoteDependencies,
  type ValidatedTarget,
} from "../src/index";
import { createFetchHarness } from "./harness";

describe("web_fetch cancellation", () => {
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

  it("times out while waiting for response headers", async () => {
    await expect(
      fetchRemoteContent(`${origin}/slow`, 0, 6_000, undefined, {
        ...dependencies,
        timeoutMs: 20,
      }),
    ).rejects.toThrow("web_fetch timed out after 0.02 seconds.");
  });

  it("times out while the response body is stalled after headers", async () => {
    const ready = fixture.waitForStalledBody();

    const pending = fetchRemoteContent(`${origin}/stalled-body`, 0, 6_000, undefined, {
      ...dependencies,
      timeoutMs: 100,
    });

    await ready;
    await expect(pending).rejects.toThrow("web_fetch timed out after 0.1 seconds.");
  });

  it("cancels while the response body is stalled after headers", async () => {
    const controller = new AbortController();
    const ready = fixture.waitForStalledBody();

    const pending = fetchRemoteContent(`${origin}/stalled-body`, 0, 6_000, controller.signal, {
      ...dependencies,
      timeoutMs: 10_000,
    });

    await ready;
    controller.abort();
    await expect(pending).rejects.toThrow("web_fetch was cancelled.");
  });

  it.each([
    { trigger: "deadline", message: "web_fetch timed out after 1 seconds." },
    { trigger: "caller abort", message: "web_fetch was cancelled." },
  ])("stops stalled HTML extraction on $trigger", async ({ trigger, message }) => {
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });

    try {
      const pending = fetchRemoteContent(`${origin}/html`, 0, 6_000, controller.signal, {
        ...dependencies,
        extractHtml: () => {
          started.resolve();

          return new Promise<never>(() => {});
        },
        timeoutMs: 1_000,
      });

      // Fail promptly if the request fails or settles before reaching extraction.
      const extractionStarted = await Promise.race([
        started.promise.then(() => true),
        pending.then(() => false),
      ]);

      expect(extractionStarted).toBe(true);
      const rejection = expect(pending).rejects.toThrow(message);

      if (trigger === "deadline") await vi.advanceTimersByTimeAsync(1_000);
      else controller.abort();
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out while initial URL validation is stalled", async () => {
    let requestCount = 0;
    await expect(
      fetchRemoteContent("https://example.test", 0, 6_000, undefined, {
        validateUrl: () => new Promise<ValidatedTarget>(() => {}),
        request: async () => {
          requestCount += 1;
          throw new Error("request should not be called");
        },
        timeoutMs: 20,
      }),
    ).rejects.toThrow("web_fetch timed out after 0.02 seconds.");
    expect(requestCount).toBe(0);
  });

  it("times out while redirect URL validation is stalled", async () => {
    const validated: string[] = [];
    await expect(
      fetchRemoteContent(`${origin}/redirect`, 0, 6_000, undefined, {
        ...dependencies,
        validateUrl: async (value) => {
          const url = value instanceof URL ? value : new URL(value);
          validated.push(url.pathname);

          if (url.pathname === "/html") return await new Promise<ValidatedTarget>(() => {});

          return { url, address: "127.0.0.1", family: 4 };
        },
        timeoutMs: 100,
      }),
    ).rejects.toThrow("web_fetch timed out after 0.1 seconds.");
    expect(validated).toEqual(["/redirect", "/html"]);
  });

  it("cancels stalled initial validation and ignores its late settlement", async () => {
    const controller = new AbortController();
    let resolveValidation: (target: ValidatedTarget) => void = () => {};

    const validation = new Promise<ValidatedTarget>((resolve) => {
      resolveValidation = resolve;
    });

    let requestCount = 0;

    const pending = fetchRemoteContent("https://example.test", 0, 6_000, controller.signal, {
      validateUrl: () => validation,
      request: async () => {
        requestCount += 1;
        throw new Error("request should not be called");
      },
      timeoutMs: 10_000,
    });

    controller.abort();
    await expect(pending).rejects.toThrow("web_fetch was cancelled.");
    expect(requestCount).toBe(0);
    resolveValidation({
      url: new URL("https://example.test"),
      address: "93.184.216.34",
      family: 4,
    });
    await validation;
    expect(requestCount).toBe(0);
  });
});
