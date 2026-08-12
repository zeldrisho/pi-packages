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

  it("distinguishes timeout from caller cancellation", async () => {
    await expect(
      fetchRemoteContent(`${origin}/slow`, 0, 6_000, undefined, {
        ...dependencies,
        timeoutMs: 20,
      }),
    ).rejects.toThrow("timed out");

    const controller = new AbortController();
    const pending = fetchRemoteContent(`${origin}/slow`, 0, 6_000, controller.signal, dependencies);
    controller.abort();
    await expect(pending).rejects.toThrow("cancelled");
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

  it("times out while HTML extraction is stalled", async () => {
    let extractionCount = 0;
    await expect(
      fetchRemoteContent(`${origin}/html`, 0, 6_000, undefined, {
        ...dependencies,
        extractHtml: () => {
          extractionCount += 1;
          return new Promise<never>(() => {});
        },
        timeoutMs: 20,
      }),
    ).rejects.toThrow("web_fetch timed out after 0.02 seconds.");
    expect(extractionCount).toBe(1);
  });

  it("cancels while HTML extraction is stalled", async () => {
    const controller = new AbortController();
    let extractionStarted = false;
    const pending = fetchRemoteContent(`${origin}/html`, 0, 6_000, controller.signal, {
      ...dependencies,
      extractHtml: () => {
        extractionStarted = true;
        return new Promise<never>(() => {});
      },
      timeoutMs: 10_000,
    });

    await vi.waitFor(() => expect(extractionStarted).toBe(true));
    controller.abort();
    await expect(pending).rejects.toThrow("web_fetch was cancelled.");
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

  it("cancels while initial URL validation is stalled", async () => {
    const controller = new AbortController();
    let requestCount = 0;
    const pending = fetchRemoteContent("https://example.test", 0, 6_000, controller.signal, {
      validateUrl: () => new Promise<ValidatedTarget>(() => {}),
      request: async () => {
        requestCount += 1;
        throw new Error("request should not be called");
      },
      timeoutMs: 10_000,
    });

    controller.abort();
    await expect(pending).rejects.toThrow("web_fetch was cancelled.");
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

  it("ignores late validation settlement after cancellation", async () => {
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
    resolveValidation({
      url: new URL("https://example.test"),
      address: "93.184.216.34",
      family: 4,
    });
    await validation;
    expect(requestCount).toBe(0);
  });
});
