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
    await expect(discoverProjectId("access", undefined)).rejects.toThrow(
      /loadCodeAssist: HTTP 403; loadCodeAssist: HTTP 403/,
    );
  });
  it("reports a known Google scope reason without exposing error details", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: {
              message: "private data",
              details: [
                { reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT", metadata: { token: "secret" } },
              ],
            },
          },
          { status: 403 },
        ),
      ),
    );

    await expect(discoverProjectId("secret", undefined)).rejects.toThrow(
      /HTTP 403 \(ACCESS_TOKEN_SCOPE_INSUFFICIENT\)/,
    );
    await expect(discoverProjectId("secret", undefined)).rejects.not.toThrow(/secret|private data/);
  });

  it("reports only allowlisted service names", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: {
              details: [
                {
                  reason: "SERVICE_DISABLED",
                  metadata: { service: "cloudcode-pa.googleapis.com", consumer: "private-project" },
                },
              ],
            },
          },
          { status: 403 },
        ),
      ),
    );
    await expect(discoverProjectId("secret", undefined)).rejects.toThrow(
      /SERVICE_DISABLED; service=cloudcode-pa\.googleapis\.com/,
    );
    await expect(discoverProjectId("secret", undefined)).rejects.not.toThrow(
      /private-project|secret/,
    );
  });

  it("does not reflect unknown or oversized provider reasons", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ error: { details: [{ reason: "secret" }] } }, { status: 403 }),
      ),
    );
    await expect(discoverProjectId("secret", undefined)).rejects.not.toThrow(/secret/);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: {
              details: [
                { reason: "SERVICE_DISABLED", metadata: { service: "private-project-secret" } },
              ],
            },
          },
          { status: 403 },
        ),
      ),
    );
    await expect(discoverProjectId("secret", undefined)).rejects.not.toThrow(
      /private-project-secret/,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("x".repeat(20_000), { status: 403 })),
    );
    await expect(discoverProjectId("secret", undefined)).rejects.toThrow(/HTTP 403/);
  });

  it("reports successful responses without project IDs, including companion lookup statuses", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(new Response("private response", { status: 403 }))
      .mockResolvedValueOnce(new Response("private response", { status: 404 }))
      .mockResolvedValueOnce(new Response("private response", { status: 401 }));

    vi.stubGlobal("fetch", fetch);

    await expect(discoverProjectId("private-token", undefined)).rejects.toThrow(
      /loadCodeAssist: HTTP 200; listCloudAICompanionProjects: HTTP 403; listCloudAICompanionProjects: HTTP 404; loadCodeAssist: HTTP 401/,
    );
  });
  it("never includes provider or network error contents in diagnostics", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("private-token");
      }),
    );

    await expect(discoverProjectId("private-token", undefined)).rejects.toThrow(
      /network or response error/,
    );
    await expect(discoverProjectId("private-token", undefined)).rejects.not.toThrow(
      /private-token/,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("private response", { status: 403 })),
    );
    await expect(discoverProjectId("private-token", undefined)).rejects.not.toThrow(
      /private response/,
    );
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
