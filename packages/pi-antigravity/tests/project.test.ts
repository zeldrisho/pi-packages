import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  antigravityHeaders,
  discoverProjectId,
  discoverySignal,
  extractProjectId,
} from "../src/project";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("project discovery", () => {
  it("uses the returned project and sends the required metadata", async () => {
    const fetch = vi.fn(async () => Response.json({ cloudaicompanionProject: { id: "project" } }));
    vi.stubGlobal("fetch", fetch);
    await expect(discoverProjectId("access", undefined)).resolves.toBe("project");
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("falls back to the second endpoint after an error", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(Response.json({ projectId: "fallback" }));

    vi.stubGlobal("fetch", fetch);
    await expect(discoverProjectId("access", undefined)).resolves.toBe("fallback");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("lists companion projects when loadCodeAssist omits the id", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(Response.json({ projects: [{ id: "listed" }] }));

    vi.stubGlobal("fetch", fetch);
    await expect(discoverProjectId("access", undefined)).resolves.toBe("listed");
  });
  it("rejects if no endpoint returns a usable project", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unavailable", { status: 403 })),
    );
    await expect(discoverProjectId("access", undefined)).rejects.toThrow(/could not resolve/);
  });
  it("propagates caller cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("cancelled");
      }),
    );
    await expect(discoverProjectId("access", controller.signal)).rejects.toThrow("cancelled");
  });
  it("reads lists and ignores unusable entries", () => {
    expect(extractProjectId({ projects: [null, {}, { id: "ok" }] })).toBe("ok");
    expect(extractProjectId({ projects: "invalid" })).toBeUndefined();
    expect(extractProjectId({ project: { id: "" } })).toBeUndefined();
    expect(extractProjectId({ projectIds: ["first"] })).toBe("first");
  });
  it("combines caller cancellation and a deadline", () => {
    const controller = new AbortController();
    const signal = discoverySignal(controller.signal, 10000);
    expect(signal.aborted).toBe(false);
    controller.abort();
    expect(signal.aborted).toBe(true);
    expect(discoverySignal(undefined, 10000).aborted).toBe(false);
  });
  it("supports a user-agent override without affecting authorization", async () => {
    vi.stubEnv("PI_ANTIGRAVITY_USER_AGENT", "example-client");
    const headers = await antigravityHeaders("token");
    expect(headers.get("User-Agent")).toBe("example-client");
    expect(headers.get("Authorization")).toBe("Bearer token");
  });
});
